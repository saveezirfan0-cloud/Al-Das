/**
 * Insurer filter (docs/45 P5 follow-up): public.v_contact_insurers lists the payers that have a matched claim with a
 * patient (by Unite PIN). Service role only; the field is hidden without finance.claims.view and never builds a
 * marketing audience. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { audiencePurposeProblem } from "@/lib/campaigns/audience-purpose";
import { compileContactPredicate } from "@/lib/contacts/query";
import { and, cond, type Filter } from "@/lib/filters/ast";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Insurer filter (claims by PIN)", () => {
  let c: Client;
  let org: string;
  let owner: string;
  const id: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-ins@example.test");
    org = await createOrg(c, "Org INS", "org-ins", owner);
    await svc(async () => {
      const person = async (first: string, pin: string | null, phone: string) =>
        (
          await q(
            "insert into public.contacts (org_id, first_name, last_name, external_id, phone_e164) values ($1, $2, 'Demo', $3, $4) returning id::text",
            [org, first, pin, phone],
          )
        ).rows[0].id as string;
      id.axa = await person("Layla", "PIN-I-1", "+447700900201");
      id.two = await person("Omar", "PIN-I-2", "+447700900202");
      id.none = await person("Sara", "PIN-I-3", "+447700900203");
      id.lead = await person("Lead", null, "+447700900204");
      const batch = (
        await q(
          `insert into public.fin_raw_unite_batches (org_id, from_date, to_date, count_requested, record_count, payload)
           values ($1, current_date - 60, current_date, 50, 3, '{"Data":[]}') returning id`,
          [org],
        )
      ).rows[0].id as string;
      const invoice = async (n: string, pin: string, deleted = false) =>
        (
          await q(
            `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, inv_type,
               department, doctor_dha_id, doctor_name, gross, discount, net, vat, total, write_off, credit_note, is_deleted,
               record_hash, last_batch_id)
             values ($1, $2, current_date, $3, 'P', 'INSURANCE', 'Dental', 'DHA-T-1', 'Dr Test', 100, 0, 100, 5, 105, 0, 0, $4, 'h', $5)
             returning id::text`,
            [org, `ADMC/I/${n}`, pin, deleted, batch],
          )
        ).rows[0].id as string;
      const claim = (n: string, inv: string | null, payer: string | null, status = "matched") =>
        q(
          `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, matched_invoice_id, match_status,
             transaction_date, cpt_code, cpt_category, clinician_id, payer_id, net, remitted, rejected, claim_status,
             resubmission_count, claim_year, claim_month)
           values ($1, $2, 'x', $3, $4, current_date, '99213', 'Procedures', 'DHA-T-1', $5, 100, 0, 0, null, 0, 2026, 10)`,
          [org, `CA-I-${n}`, inv, status, payer],
        );
      const i1 = await invoice("1", "PIN-I-1");
      const i2 = await invoice("2", "PIN-I-2");
      const i2b = await invoice("3", "PIN-I-2");
      const gone = await invoice("4", "PIN-I-3", true);
      await claim("1", i1, "AXA");
      await claim("2", i2, "AXA");
      await claim("3", i2b, "MEDNET");
      await claim("4", i2b, "MEDNET"); // the same payer twice is one row
      await claim("5", gone, "AXA"); // a deleted invoice does not count
      await claim("6", null, "AXA", "unmatched"); // not matched to an invoice
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("lists each payer once per patient, from matched claims on current invoices only", async () => {
    const rows = await svc(
      async () =>
        (
          await q(
            "select contact_id::text, payer_id from public.v_contact_insurers where org_id = $1 order by 1, 2",
            [org],
          )
        ).rows as Array<{ contact_id: string; payer_id: string }>,
    );
    const of = (cid: string) => rows.filter((r) => r.contact_id === cid).map((r) => r.payer_id);
    expect(of(id.axa)).toEqual(["AXA"]);
    expect(of(id.two).sort()).toEqual(["AXA", "MEDNET"]);
    expect(of(id.none)).toEqual([]);
    expect(of(id.lead)).toEqual([]);
  });

  it("is readable by the service role only", async () => {
    await expect(
      asUser(c, owner, () => q("select * from public.v_contact_insurers limit 1")),
    ).rejects.toThrow(/permission denied/);
  });

  it("counts patients by insurer through the segment compiler", async () => {
    const registry = buildContactFieldRegistry();
    const countFor = async (filter: Filter) => {
      const { sql, params } = compileContactPredicate(registry, filter, null, "UTC");
      return svc(async () =>
        Number(
          (
            await q("select public.contacts_count($1, $2, $3::jsonb) as n", [
              org,
              sql,
              JSON.stringify(params),
            ])
          ).rows[0].n,
        ),
      );
    };
    const f = (payers: string[]): Filter => ({
      include: and(cond("insurer", "has_any", payers)),
      exclude: null,
    });
    expect(await countFor(f(["AXA"]))).toBe(2);
    expect(await countFor(f(["MEDNET"]))).toBe(1);
    expect(await countFor(f(["AXA", "MEDNET"]))).toBe(2);
    expect(await countFor(f(["OTHER"]))).toBe(0);
  });

  it("is hidden without claims access and refused for marketing", () => {
    expect(buildContactFieldRegistry({ claimsAvailable: false }).get("insurer")?.available).toBe(
      false,
    );
    expect(() =>
      buildContactFieldRegistry({ claimsAvailable: false }).require("insurer"),
    ).toThrow();
    const registry = buildContactFieldRegistry();
    expect(registry.get("insurer")?.available).toBe(true);
    const filter: Filter = { include: and(cond("insurer", "has_any", ["AXA"])), exclude: null };
    expect(audiencePurposeProblem(filter, "marketing", registry)).toMatch(/Care programmes only/);
    expect(audiencePurposeProblem(filter, "care", registry)).toBeNull();
  });

  it("makes a dynamic segment that uses it care only in the database", async () => {
    const seg = await svc(
      async () =>
        (
          await q(
            "insert into public.segments (org_id, name, kind, filter) values ($1, 'By insurer', 'dynamic', $2::jsonb) returning care_only",
            [
              org,
              JSON.stringify({ include: and(cond("insurer", "has_any", ["AXA"])), exclude: null }),
            ],
          )
        ).rows[0].care_only as boolean,
    );
    expect(seg).toBe(true);
  });
});
