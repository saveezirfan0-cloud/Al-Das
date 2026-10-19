/**
 * W3 follow-ups (docs/48_FOLLOWUPS_DEPOSITS_NOTES.md), database side:
 * - ins_claims_for_remittance returns paid_before from earlier committed advice, leaving out the given file, netting
 *   take-backs and never below 0 (null when the claim was never on committed advice);
 * - fin_bank_insurance_payments sums committed lines per batch, payment reference and payer (service role only);
 * - a group of payments fits in fin_bank_matches.expected_key (widened to 1000);
 * - rule E15 opens an exception for an insurer-account credit still unmatched and unexplained after the threshold, is
 *   idempotent, auto-closes when a reason is given, and stays silent before remittances or a reconciliation exist.
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Finance deposit follow-ups (W3)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const day = async (offset: number) =>
    (await q("select (current_date + $1::int)::text as d", [offset])).rows[0].d as string;

  async function file(org: string, sha: string) {
    return (
      await q(
        "insert into public.fin_raw_remittance_files (org_id, file_sha256, uploaded_by, status, committed_at) values ($1, $2, $3, 'committed', now()) returning id",
        [org, sha, alice],
      )
    ).rows[0].id as string;
  }
  async function batch(
    org: string,
    fileId: string | null,
    opts: { ref?: string | null; paidOn?: string; sum?: number } = {},
  ) {
    return (
      await q(
        "insert into public.ins_remittance_batches (org_id, file_id, remittance_ref, payer_id, paid_on, sum_paid) values ($1, $2, $3, 'PAYER-SYN', $4::date, $5) returning id",
        [org, fileId, opts.ref ?? null, opts.paidOn ?? "2026-10-01", opts.sum ?? 0],
      )
    ).rows[0].id as string;
  }
  let lineNo = 0;
  async function remitLine(
    org: string,
    batchId: string,
    paid: number,
    o: { claim?: string | null; ref?: string; payer?: string | null } = {},
  ) {
    lineNo++;
    await q(
      `insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, remittance_ref, payer_id, paid_amount, claim_activity_id, match_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        org,
        batchId,
        lineNo,
        `k${lineNo}`,
        o.ref ?? "RM-SYN",
        o.payer === undefined ? "PAYER-SYN" : o.payer,
        paid,
        o.claim ?? null,
        o.claim ? "matched" : "unmatched",
      ],
    );
  }
  async function claim(org: string, n: string) {
    return (
      await q(
        "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, net) values ($1, $2, $3, '99213', 'PAYER-SYN', 400) returning id",
        [org, n, `ADMC/C/${n}`],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-dep@example.test");
    const bob = await createAuthUser(c, "bob-dep@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
  });
  afterAll(async () => {
    await c?.end();
  });

  describe("ins_claims_for_remittance: paid_before", () => {
    it("sums earlier committed advice per claim, leaves out the given file, nets take-backs, never below 0", () =>
      svc(async () => {
        const [k1, k2, k3, k4] = [
          await claim(orgA, "CA-1"),
          await claim(orgA, "CA-2"),
          await claim(orgA, "CA-3"),
          await claim(orgA, "CA-4"),
        ];
        const f1 = await file(orgA, "sha-f1");
        const f2 = await file(orgA, "sha-f2");
        const f3 = await file(orgA, "sha-f3");
        const b1 = await batch(orgA, f1);
        const b2 = await batch(orgA, f2);
        const b3 = await batch(orgA, f3);
        await remitLine(orgA, b1, 150, { claim: k1 }); // part payment on an earlier file
        await remitLine(orgA, b2, 250, { claim: k1 }); // the file being previewed (completes it)
        await remitLine(orgA, b1, 200, { claim: k2 });
        await remitLine(orgA, b3, -200, { claim: k2 }); // taken back on a later file
        await remitLine(orgA, b3, -50, { claim: k3 }); // a take-back with no payment we hold
        const call = async (exclude: string | null) => {
          const rows = (
            await q("select public.ins_claims_for_remittance($1, $2, '{}', $3) as r", [
              orgA,
              ["CA-1", "ca-2 ", "CA-3", "CA-4"],
              exclude,
            ])
          ).rows[0].r as Array<{
            claim_activity_number: string;
            paid_before: number | null;
            net: number;
          }>;
          return Object.fromEntries(
            rows.map((r) => [
              r.claim_activity_number,
              r.paid_before === null ? null : Number(r.paid_before),
            ]),
          );
        };
        expect(await call(f2)).toEqual({ "CA-1": 150, "CA-2": 0, "CA-3": 0, "CA-4": null });
        expect(await call(null)).toEqual({ "CA-1": 400, "CA-2": 0, "CA-3": 0, "CA-4": null });
        // every earlier field is still there, and the invoice-key lookup still works
        const byKey = (
          await q("select public.ins_claims_for_remittance($1, '{}', $2) as r", [
            orgA,
            ["ADMC/C/CA-4"],
          ])
        ).rows[0].r as Array<Record<string, unknown>>;
        expect(byKey).toHaveLength(1);
        expect(Object.keys(byKey[0]).sort()).toEqual(
          [
            "activity_start_date",
            "claim_activity_number",
            "cpt_code",
            "id",
            "invoice_no",
            "net",
            "paid_before",
            "payer_id",
            "quantity",
            "transaction_date",
          ].sort(),
        );
        void k4;
      }));

    it("another org's advice never counts", () =>
      svc(async () => {
        const kb = await claim(orgB, "CA-1");
        const fb = await file(orgB, "sha-b1");
        await remitLine(orgB, await batch(orgB, fb), 999, { claim: kb });
        const rows = (
          await q("select public.ins_claims_for_remittance($1, $2, '{}') as r", [orgA, ["CA-1"]])
        ).rows[0].r as Array<{ paid_before: number }>;
        expect(rows.map((r) => Number(r.paid_before))).toEqual([400]);
      }));

    it("signed-in users cannot call it", async () => {
      await expect(
        asUser(c, alice, () =>
          q("select public.ins_claims_for_remittance($1, '{}', '{}')", [orgA]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("fin_bank_insurance_payments", () => {
    it("sums committed lines per batch, reference and payer", () =>
      svc(async () => {
        const f = await file(orgA, "sha-split");
        const b = await batch(orgA, f, { sum: 350 });
        await remitLine(orgA, b, 100, { ref: "RM-SPLIT-1" });
        await remitLine(orgA, b, 50, { ref: " rm-split-1" });
        await remitLine(orgA, b, 200, { ref: "RM-SPLIT-2", payer: null }); // payer from the batch
        const all = (
          await q("select public.fin_bank_insurance_payments($1, now() - interval '1 day') as r", [
            orgA,
          ])
        ).rows[0].r as Array<{
          batch_id: string;
          ref: string;
          payer_id: string;
          amount: number;
          lines: number;
        }>;
        const mine = all.filter((p) => p.batch_id === b);
        expect(
          mine.map((p) => [p.ref.toUpperCase().trim(), p.payer_id, Number(p.amount), p.lines]),
        ).toEqual([
          ["RM-SPLIT-1", "PAYER-SYN", 150, 2],
          ["RM-SPLIT-2", "PAYER-SYN", 200, 1],
        ]);
        const later = (
          await q("select public.fin_bank_insurance_payments($1, now() + interval '1 day') as r", [
            orgA,
          ])
        ).rows[0].r as unknown[];
        expect(later).toEqual([]);
      }));

    it("signed-in users cannot call it", async () => {
      await expect(
        asUser(c, alice, () => q("select public.fin_bank_insurance_payments($1, now())", [orgA])),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("bank run storage and rule E15", () => {
    let accIns: string;
    let accOps: string;
    let recIns: string;
    const ids: Record<string, string> = {};
    const run = async () =>
      (await q("select public.fin_run_exception_rules($1) as r", [orgA])).rows[0].r as Record<
        string,
        { opened?: number; closed?: number; skipped?: boolean }
      >;
    const open = async () =>
      (
        await q(
          "select entity_key, entity_type, owner_role, detail from public.ops_exceptions where org_id = $1 and rule_code = 'E15' and status in ('open','in_progress') order by 1",
          [orgA],
        )
      ).rows as Array<{
        entity_key: string;
        entity_type: string;
        owner_role: string;
        detail: Record<string, unknown>;
      }>;

    beforeAll(() =>
      svc(async () => {
        await q("delete from public.ins_remittance_lines where org_id = $1", [orgA]);
        await q("delete from public.ins_remittance_batches where org_id = $1", [orgA]);
        accIns = (
          await q(
            "insert into public.fin_bank_accounts (org_id, name, bank_name, last4, receives_insurance) values ($1, 'Insurance', 'Synthetic Bank', '1111', true) returning id",
            [orgA],
          )
        ).rows[0].id;
        accOps = (
          await q(
            "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', '2222') returning id",
            [orgA],
          )
        ).rows[0].id;
        const rows = [
          { key: "old", offset: -40, amount: 500 },
          { key: "recent", offset: -5, amount: 300 },
          { key: "beforeRec", offset: -50, amount: 100 },
          { key: "debit", offset: -40, amount: -80 },
          { key: "grouped", offset: -39, amount: 425 },
        ];
        const json = [];
        for (const r of rows)
          json.push({
            value_date: await day(r.offset),
            amount: r.amount,
            reference: `SYN-${r.key}`,
            description: "SYNTHETIC",
          });
        const imp = (
          await q(
            "select public.fin_bank_import($1, 'bank_statement', $2, null, null, 'statement.csv', $5, $3::jsonb, $4) as id",
            [orgA, accIns, JSON.stringify(json), alice, sha("ins")],
          )
        ).rows[0].id;
        const lines = (
          await q(
            "select id, row_no from public.fin_bank_lines where import_id = $1 order by row_no",
            [imp],
          )
        ).rows;
        rows.forEach((r, i) => (ids[r.key] = lines[i].id));
        await q(
          "select public.fin_bank_import($1, 'bank_statement', $2, null, null, 'statement.csv', $5, $3::jsonb, $4)",
          [
            orgA,
            accOps,
            JSON.stringify([
              {
                value_date: await day(-40),
                amount: 700,
                reference: "SYN-ops",
                description: "SYNTHETIC",
              },
            ]),
            alice,
            sha("ops"),
          ],
        );
        const start = await day(-45);
        recIns = (
          await q(
            "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end, created_by) values ($1, $2, date_trunc('month', $3::date)::date, $3::date, current_date, $4) returning id",
            [orgA, accIns, start, alice],
          )
        ).rows[0].id;
      }),
    );

    it("is skipped before any remittance advice exists (start-up guard)", () =>
      svc(async () => {
        expect((await run()).E15).toEqual({ skipped: true });
        expect(await open()).toEqual([]);
      }));

    it("opens one deposit exception per old, unexplained insurer-account credit; ids, dates and amounts only", () =>
      svc(async () => {
        await batch(orgA, null, { paidOn: await day(-60), sum: 0 });
        expect((await run()).E15).toEqual({ opened: 2, closed: 0 });
        const got = await open();
        expect(got.map((g) => g.entity_key).sort()).toEqual([ids.old, ids.grouped].sort());
        expect(got.every((g) => g.entity_type === "deposit" && g.owner_role === "finance")).toBe(
          true,
        );
        expect(Object.keys(got[0].detail).sort()).toEqual([
          "account_id",
          "amount",
          "days",
          "value_date",
        ]);
        expect(JSON.stringify(got)).not.toContain("SYN-");
        expect(JSON.stringify(got)).not.toContain("SYNTHETIC");
      }));

    it("is idempotent", () =>
      svc(async () => {
        expect((await run()).E15).toEqual({ opened: 0, closed: 0 });
      }));

    it("clears when a reason is given or the credit is matched (a group of payments fits the key column)", () =>
      svc(async () => {
        await q(
          "insert into public.fin_bank_rec_notes (org_id, rec_id, item_key, reason_code, decided_by) values ($1, $2, $3, 'other_income', $4)",
          [orgA, recIns, `bank|${ids.old}`, alice],
        );
        const longKey = `insg|${Array.from({ length: 8 }, (_, i) => `ins|00000000-0000-4000-8000-00000000000${i}|0000000${i}`).join("+")}`;
        expect(longKey.length).toBeGreaterThan(160);
        await q(
          `insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status, decided_by)
           values ($1, $2, $3, $4, 'insurance', current_date - 39, 425, 425, 70, 'matched', $5)`,
          [orgA, recIns, ids.grouped, longKey, alice],
        );
        expect((await run()).E15).toEqual({ opened: 0, closed: 2 });
        expect(await open()).toEqual([]);
        await expect(
          q(
            `insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status)
             values ($1, $2, $3, $4, 'insurance', current_date, 1, 1, 1, 'rejected')`,
            [orgA, recIns, ids.recent, "x".repeat(1001)],
          ),
        ).rejects.toThrow(/check/);
      }));

    it("is switched off by a blank threshold (data, not code)", () =>
      svc(async () => {
        await q(
          "update public.fin_ref_exception_rules set threshold_days = null where org_id = $1 and rule_code = 'E15'",
          [orgA],
        );
        expect((await run()).E15).toEqual({ skipped: true });
        await q(
          "update public.fin_ref_exception_rules set threshold_days = 10 where org_id = $1 and rule_code = 'E15'",
          [orgA],
        );
      }));

    it("every org gets the E15 rule with a threshold from data", () =>
      svc(async () => {
        const { rows } = await q(
          "select org_id, owner_role, threshold_days from public.fin_ref_exception_rules where rule_code = 'E15' and org_id = any ($1) order by org_id",
          [[orgA, orgB]],
        );
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.owner_role === "finance" && r.threshold_days === 10)).toBe(true);
      }));
  });
});
