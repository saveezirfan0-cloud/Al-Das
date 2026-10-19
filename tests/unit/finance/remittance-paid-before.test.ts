/**
 * W3 follow-up 2 (docs/48): the remittance preview asks ins_claims_for_remittance for each claim's `paid_before`,
 * leaving out the file being previewed, and the pure matcher uses it: a payment that completes a part-paid claim is not
 * short, and a second full payment is overpaid. The database side is tests/db/finance-deposit-followups.test.ts.
 * A fake service-role client; synthetic data only.
 */
import { describe, expect, it } from "vitest";

import { buildRemittancePreview } from "@/lib/finance/remittance-service";
import type { AdminClient } from "@/lib/supabase/admin";

const FILE = "00000000-0000-4000-8000-000000000f01";
const ORG = "00000000-0000-4000-8000-000000000001";

type Rpc = { name: string; args: Record<string, unknown> };

function fakeAdmin(paidBefore: number | null, paid: number) {
  const calls: Rpc[] = [];
  const tables: Record<string, unknown[]> = {
    fin_raw_remittance_files: [{ id: FILE, status: "validated", header_check: null }],
    fin_staged_remittance_lines: [
      {
        row_no: 2,
        data: {
          remittance_ref: "RM-SYN-2",
          paid_on: "2026-11-02",
          payer_id: "PAYER-A",
          claim_activity_number: null,
          invoice_no: "ADMC/C/80004",
          cpt_code: "99214",
          quantity: 1,
          claimed_amount: 400,
          paid_amount: paid,
          denied_amount: 0,
          denial_code: null,
        },
      },
    ],
    fin_ref_finance_settings: [],
    fin_ref_payer_prices: [],
  };
  const builder = (rows: unknown[]) => {
    let from = 0;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "gte", "lte", "is"]) b[m] = () => b;
    b.range = (a: number) => {
      from = a;
      return b;
    };
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    b.single = b.maybeSingle;
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: from === 0 ? rows : [], error: null }).then(ok);
    return b;
  };
  const admin = {
    from: (t: string) => builder(tables[t] ?? []),
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: [
          {
            id: "claim-1",
            claim_activity_number: "CA-SYN-4",
            invoice_no: "ADMC/C/80004",
            cpt_code: "99214",
            payer_id: "PAYER-A",
            quantity: "1",
            net: "400",
            transaction_date: "2026-09-02",
            activity_start_date: "2026-09-02",
            paid_before: paidBefore === null ? null : String(paidBefore),
          },
        ],
        error: null,
      });
    },
  };
  return { admin: admin as unknown as AdminClient, calls };
}

describe("remittance preview with paid_before", () => {
  it("leaves out the file being previewed when it asks for earlier payments", async () => {
    const { admin, calls } = fakeAdmin(150, 250);
    await buildRemittancePreview(admin, ORG, FILE);
    expect(calls.map((c) => c.name)).toEqual(["ins_claims_for_remittance"]);
    expect(calls[0].args).toMatchObject({ p_org_id: ORG, p_exclude_file_id: FILE });
  });

  it("a payment that completes a part-paid claim is not short", async () => {
    const { admin } = fakeAdmin(150, 250);
    const p = await buildRemittancePreview(admin, ORG, FILE);
    expect(p?.summary).toMatchObject({ matched: 1, short: 0, overpaid: 0, sumExpected: 250 });
  });

  it("a second full payment is overpaid", async () => {
    const { admin } = fakeAdmin(400, 400);
    const p = await buildRemittancePreview(admin, ORG, FILE);
    expect(p?.summary).toMatchObject({ short: 0, overpaid: 1, sumExpected: 0 });
    expect(p?.attention[0].flags).toContain("overpaid");
  });

  it("with nothing paid before, a part payment is still short", async () => {
    const { admin } = fakeAdmin(null, 250);
    const p = await buildRemittancePreview(admin, ORG, FILE);
    expect(p?.summary).toMatchObject({ short: 1, sumShort: 150 });
  });
});
