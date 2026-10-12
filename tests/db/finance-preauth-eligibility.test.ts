/**
 * Pre-authorisation tracker and eligibility checks, database side: constraints, the cross-org parent checks, the claim
 * link, record history, and the "ready to bill" view, which must give the same answers as the pure TypeScript rules
 * (both run the shared fixture tests/unit/finance/fixtures/phase18-readiness.synthetic.json). Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays } from "@/lib/documents/expiry";

import fixture from "../unit/finance/fixtures/phase18-readiness.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)(
  "phase 18: pre-authorisations, eligibility, ready to bill",
  () => {
    let c: Client;
    let alice: string;
    let bob: string;
    let orgA: string;
    let orgB: string;
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const code = (sql: string, params: unknown[] = []) =>
      q("savepoint t")
        .then(() => q(sql, params))
        .then(
          () => q("release savepoint t").then(() => "ok"),
          (e: { code?: string }) => q("rollback to savepoint t").then(() => e.code ?? "error"),
        );

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      bob = await createAuthUser(c, "bob@example.test");
      orgA = await createOrg(c, "Org A", "org-a", alice);
      orgB = await createOrg(c, "Org B", "org-b", bob);
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("refuses an approval without the payer's reference and an expiry date (the table fails closed)", async () => {
      await asServiceRole(c, async () => {
        await q("begin");
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status) values ($1, 'P1', 'PA', 'approved')",
            [orgA],
          ),
        ).toBe("23514");
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number) values ($1, 'P1', 'PA', 'approved', 'A1')",
            [orgA],
          ),
        ).toBe("23514");
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, expires_on) values ($1, 'P1', 'PA', 'approved', 'A1', '2027-01-01')",
            [orgA],
          ),
        ).toBe("ok");
        // no patient identity at all
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, payer_id, status) values ($1, 'PA', 'requested')",
            [orgA],
          ),
        ).toBe("23514");
        // the same authorisation number twice for one payer
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, expires_on) values ($1, 'P2', 'PA', 'approved', 'A1', '2027-01-01')",
            [orgA],
          ),
        ).toBe("23505");
        // ... but another payer may reuse the number
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, expires_on) values ($1, 'P2', 'PB', 'approved', 'A1', '2027-01-01')",
            [orgA],
          ),
        ).toBe("ok");
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, valid_from, expires_on) values ($1, 'P3', 'PA', 'requested', '2027-02-01', '2027-01-01')",
            [orgA],
          ),
        ).toBe("23514");
        await q("rollback");
      });
    });

    it("refuses a verified eligibility check without validity dates, and a parent from another organisation", async () => {
      await asServiceRole(c, async () => {
        await q("begin");
        expect(
          await code(
            "insert into public.fin_eligibility_checks (org_id, patient_pin, payer_id, status) values ($1, 'P1', 'PA', 'verified')",
            [orgA],
          ),
        ).toBe("23514");
        expect(
          await code(
            "insert into public.fin_eligibility_checks (org_id, patient_pin, payer_id, status, valid_to, checked_on) values ($1, 'P1', 'PA', 'verified', '2027-01-01', '2026-10-01')",
            [orgA],
          ),
        ).toBe("ok");
        const contactB = (
          await q(
            "insert into public.contacts (org_id, first_name) values ($1, 'B') returning id",
            [orgB],
          )
        ).rows[0].id;
        const docB = (
          await q(
            "insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, 'insurance_card', 't', 'image/jpeg', 1, 'p/' || gen_random_uuid()::text, 'ready') returning id",
            [orgB, contactB],
          )
        ).rows[0].id;
        expect(
          await code(
            "insert into public.fin_eligibility_checks (org_id, patient_pin, payer_id, status, document_id) values ($1, 'P1', 'PA', 'pending', $2)",
            [orgA, docB],
          ),
        ).toBe("23514");
        expect(
          await code(
            "insert into public.fin_eligibility_checks (org_id, contact_id, payer_id) values ($1, $2, 'PA')",
            [orgA, contactB],
          ),
        ).toBe("23514");
        expect(
          await code(
            "insert into public.fin_pre_authorisations (org_id, contact_id, payer_id, status) values ($1, $2, 'PA', 'requested')",
            [orgA, contactB],
          ),
        ).toBe("23514");
        await q("rollback");
      });
    });

    it("keeps the eligibility check when its card document is deleted (the document is referenced by id only)", async () => {
      await asServiceRole(c, async () => {
        const contact = (
          await q(
            "insert into public.contacts (org_id, first_name) values ($1, 'Doc') returning id",
            [orgA],
          )
        ).rows[0].id;
        const doc = (
          await q(
            "insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, 'insurance_card', 't', 'image/jpeg', 1, 'p/' || gen_random_uuid()::text, 'ready') returning id",
            [orgA, contact],
          )
        ).rows[0].id;
        const chk = (
          await q(
            "insert into public.fin_eligibility_checks (org_id, contact_id, payer_id, document_id) values ($1, $2, 'PA', $3) returning id",
            [orgA, contact, doc],
          )
        ).rows[0].id;
        await q("delete from public.patient_documents where id = $1", [doc]);
        const { rows } = await q(
          "select document_id from public.fin_eligibility_checks where id = $1",
          [chk],
        );
        expect(rows[0].document_id).toBeNull();
      });
    });

    it("links an approved authorisation to the claim that quotes its number, once, and never overwrites a manual link", async () => {
      await asServiceRole(c, async () => {
        const claim = async (no: string, payer: string, auth: string) =>
          (
            await q(
              "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, prior_auth_id, transaction_date) values ($1, $2, 'INV', '99213', $3, $4, '2026-10-01') returning id",
              [orgA, no, payer, auth],
            )
          ).rows[0].id as string;
        const c1 = await claim("CA-LINK-1", "PA", "AUTH-L1");
        await claim("CA-LINK-2", "OTHER", "AUTH-L2"); // another payer: must not link
        const p1 = (
          await q(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, expires_on) values ($1, 'PL1', 'PA', 'approved', 'AUTH-L1', '2027-01-01') returning id",
            [orgA],
          )
        ).rows[0].id;
        const p2 = (
          await q(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, expires_on) values ($1, 'PL2', 'PA', 'approved', 'AUTH-L2', '2027-01-01') returning id",
            [orgA],
          )
        ).rows[0].id;
        const p3 = (
          await q(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number) values ($1, 'PL3', 'PA', 'requested', 'AUTH-L1') returning id",
            [orgA],
          ).catch(() => ({ rows: [{ id: null }] }))
        ).rows[0].id;
        expect(p3).toBeNull(); // (PA, AUTH-L1) is already taken
        expect((await q("select public.fin_link_preauth_claims($1) as n", [orgA])).rows[0].n).toBe(
          1,
        );
        expect(
          (
            await q("select claim_activity_id from public.fin_pre_authorisations where id = $1", [
              p1,
            ])
          ).rows[0].claim_activity_id,
        ).toBe(c1);
        expect(
          (
            await q("select claim_activity_id from public.fin_pre_authorisations where id = $1", [
              p2,
            ])
          ).rows[0].claim_activity_id,
        ).toBeNull();
        expect((await q("select public.fin_link_preauth_claims($1) as n", [orgA])).rows[0].n).toBe(
          0,
        ); // idempotent
        expect((await q("select public.fin_link_preauth_claims($1) as n", [orgB])).rows[0].n).toBe(
          0,
        ); // other org untouched
      });
    });

    it("records who changed a pre-authorisation, but not the reminder bookkeeping", async () => {
      await asServiceRole(c, async () => {
        const id = (
          await q(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, expires_on) values ($1, 'PH1', 'PA', 'approved', 'AUTH-H1', '2027-01-01') returning id",
            [orgA],
          )
        ).rows[0].id;
        await q("update public.fin_pre_authorisations set status = 'used' where id = $1", [id]);
        await q(
          "update public.fin_pre_authorisations set expiry_notified_at = now() where id = $1",
          [id],
        );
        const { rows } = await q(
          "select op, changes from public.record_history where table_name = 'fin_pre_authorisations' and record_id = $1 order by id",
          [id],
        );
        expect(rows.map((r) => r.op)).toEqual(["insert", "update"]); // the bookkeeping update wrote nothing
        expect(rows[1].changes.status).toEqual({ from: "approved", to: "used" });
      });
    });

    it("lets only the right people read the history of these records", async () => {
      await asServiceRole(c, async () => {
        await q(
          "insert into public.fin_eligibility_checks (org_id, patient_pin, payer_id) values ($1, 'PH2', 'PA')",
          [orgA],
        );
      });
      await asUser(c, alice, async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.record_history where org_id = $1 and table_name in ('fin_pre_authorisations', 'fin_eligibility_checks')",
          [orgA],
        );
        expect(rows[0].n).toBeGreaterThan(0);
      });
      await asUser(c, bob, async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.record_history where org_id = $1",
          [orgA],
        );
        expect(rows[0].n).toBe(0);
      });
    });

    describe("v_fin_billing_readiness agrees with lib/finance/bill-readiness.ts on the shared fixture", () => {
      let offset = 0;
      const shift = (d: string | null) => (d === null ? null : addDays(d, offset));
      const reasonsByInvoice = new Map<string, string[]>();

      beforeAll(async () => {
        const dbToday = (await q("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0]
          .d as string;
        offset = Math.round((Date.parse(dbToday) - Date.parse(fixture.today)) / 86_400_000);
        await asServiceRole(c, async () => {
          await q(
            "update public.fin_ref_finance_settings set ready_start_date = $2, ready_grace_days = $3 where org_id = $1",
            [orgA, shift(fixture.settings.readyStartDate), fixture.settings.readyGraceDays],
          );
          await q(
            "insert into public.fin_ref_services (org_id, item_code, service_category, requires_preauth) values ($1, 'T-NEEDS-PA', 'Procedures', true), ($1, 'T-PLAIN', 'Consultation', false) on conflict (org_id, item_code) do update set requires_preauth = excluded.requires_preauth",
            [orgA],
          );
          let n = 0;
          for (const cs of fixture.cases) {
            n++;
            const no = `ADMC/C/RDY${String(n).padStart(3, "0")}`;
            const inv = (
              await q(
                "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, inv_type, gross, net, total, record_hash) values ($1, $2, $3, $4, 'P', 'INSURANCE', 100, 100, 100, 'h') returning id",
                [orgA, no, shift(cs.invoiceDate), cs.pin],
              )
            ).rows[0].id;
            await q(
              "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, qty, line_net) values ($1, $2, $3, 1, $4, 1, 100)",
              [orgA, inv, `${no}|x|1`, cs.needsPreauth ? "T-NEEDS-PA" : "T-PLAIN"],
            );
            for (const chk of cs.checks) {
              let docId: string | null = null;
              if (chk.hasDocument) {
                const contact = (
                  await q(
                    "insert into public.contacts (org_id, first_name) values ($1, 'Rdy') returning id",
                    [orgA],
                  )
                ).rows[0].id;
                docId = (
                  await q(
                    "insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, 'insurance_card', 't', 'image/jpeg', 1, 'p/' || gen_random_uuid()::text, 'ready') returning id",
                    [orgA, contact],
                  )
                ).rows[0].id;
              }
              await q(
                "insert into public.fin_eligibility_checks (org_id, patient_pin, payer_id, status, valid_from, valid_to, checked_on, document_id) values ($1, $2, 'PA', $3, $4, $5, $6, $7)",
                [
                  orgA,
                  cs.pin,
                  chk.status,
                  shift(chk.validFrom),
                  shift(chk.validTo),
                  shift(chk.checkedOn),
                  docId,
                ],
              );
            }
            for (const p of cs.preauths)
              await q(
                "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status, auth_number, valid_from, expires_on) values ($1, $2, 'PA', $3, $4, $5, $6)",
                [
                  orgA,
                  cs.pin,
                  p.status,
                  p.expiresOn ? `AUTH-${n}` : null,
                  shift(p.validFrom),
                  shift(p.expiresOn),
                ],
              );
          }
        });
        await asUser(c, alice, async () => {
          const { rows } = await q(
            "select inv_display_number, reasons from public.v_fin_billing_readiness where org_id = $1",
            [orgA],
          );
          for (const r of rows) reasonsByInvoice.set(r.inv_display_number, r.reasons);
        });
      });

      fixture.cases.forEach((cs, i) => {
        it(cs.name, () => {
          const no = `ADMC/C/RDY${String(i + 1).padStart(3, "0")}`;
          expect(reasonsByInvoice.get(no) ?? []).toEqual(cs.expected.reasons);
        });
      });

      it("shows a member only their own organisation and only with finance.eligibility.manage", async () => {
        await asUser(c, bob, async () => {
          expect(
            (await q("select count(*)::int as n from public.v_fin_billing_readiness")).rows[0].n,
          ).toBe(0);
        });
        await asServiceRole(c, async () => {
          // the check is off until a start date is set
          await q(
            "update public.fin_ref_finance_settings set ready_start_date = null where org_id = $1",
            [orgA],
          );
        });
        await asUser(c, alice, async () => {
          expect(
            (await q("select count(*)::int as n from public.v_fin_billing_readiness")).rows[0].n,
          ).toBe(0);
        });
      });
    });
  },
);
