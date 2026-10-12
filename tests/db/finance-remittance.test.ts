/**
 * Remittance reconciliation, database side: ins_commit_remittance stores a reconciled advice atomically, once, with
 * correct batch totals, skips lines it already holds, deletes the staged rows, and refuses another organisation's file.
 * The lines come from the pure matcher run over the shared fixture. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  reconcileRemittance,
  summariseReconciliation,
  type PriceRow,
  type RemitClaim,
} from "@/lib/finance/match-remittance";
import type { RemitLine } from "@/lib/finance/parse-remittance";

import fixture from "../unit/finance/fixtures/phase18-remittance.synthetic.json";
import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 18: remittance commit", () => {
  let c: Client;
  let alice: string;
  let orgA: string;
  let orgB: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const dbIds = new Map<string, string>(); // fixture claim id -> database id

  const reconciled = () =>
    reconcileRemittance(
      fixture.lines.map((l) => l.line as RemitLine),
      (fixture.claims as RemitClaim[]).map((cl) => ({ ...cl, id: dbIds.get(cl.id)! })),
      fixture.prices as PriceRow[],
      fixture.settings,
    );
  const asJson = (rows: ReturnType<typeof reconciled>) =>
    JSON.stringify(rows.map((r) => ({ ...r, flags: r.flags })));
  async function newFile(org: string, sha: string): Promise<string> {
    return (
      await q(
        "insert into public.fin_raw_remittance_files (org_id, file_sha256, uploaded_by, row_count) values ($1, $2, $3, 8) returning id",
        [org, sha, alice],
      )
    ).rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      for (const cl of fixture.claims) {
        const { rows } = await q(
          "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, quantity, net, transaction_date) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
          [
            orgA,
            cl.claim_activity_number,
            cl.invoice_no,
            cl.cpt_code,
            cl.payer_id,
            cl.quantity,
            cl.net,
            cl.transaction_date,
          ],
        );
        dbIds.set(cl.id, rows[0].id);
      }
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("commits a reconciled advice: lines, flags and batch totals match what the matcher computed", async () => {
    await asServiceRole(c, async () => {
      const fileId = await newFile(orgA, "sha-1");
      await q(
        "insert into public.fin_staged_remittance_lines (org_id, file_id, row_no, data) values ($1, $2, 2, '{}'::jsonb)",
        [orgA, fileId],
      );
      const rows = reconciled();
      const res = (
        await q("select public.ins_commit_remittance($1, $2, $3, $4::jsonb, $5::jsonb) as r", [
          orgA,
          fileId,
          alice,
          JSON.stringify({ remittance_ref: "RM-1", payer_id: "PAYER-A", paid_on: "2026-10-01" }),
          asJson(rows),
        ])
      ).rows[0].r;
      expect(res).toMatchObject({ lines: rows.length, duplicates_skipped: 0 });
      const sum = summariseReconciliation(rows);
      const batch = (
        await q(
          "select line_count, matched_count, unmatched_count, short_count, sum_paid::float as paid, sum_expected::float as expected, sum_short::float as short from public.ins_remittance_batches where id = $1",
          [res.batch_id],
        )
      ).rows[0];
      expect(batch).toEqual({
        line_count: sum.lines,
        matched_count: sum.matched,
        unmatched_count: sum.unmatched + sum.ambiguous,
        short_count: sum.short,
        paid: sum.sumPaid,
        expected: sum.sumExpected,
        short: sum.sumShort,
      });
      const short = (
        await q(
          "select claim_activity_number, short_amount::float as s, flags from public.ins_remittance_lines where batch_id = $1 and 'short_paid' = any (flags) order by 1",
          [res.batch_id],
        )
      ).rows;
      expect(short.map((r) => [r.claim_activity_number, r.s])).toEqual([
        ["CA-NOPE", 40],
        ["CA-R-2", 40],
      ]);
      expect(
        (
          await q(
            "select status, committed_by from public.fin_raw_remittance_files where id = $1",
            [fileId],
          )
        ).rows[0],
      ).toEqual({ status: "committed", committed_by: alice });
      expect(
        (
          await q(
            "select count(*)::int as n from public.fin_staged_remittance_lines where file_id = $1",
            [fileId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  it("refuses to commit the same file twice", async () => {
    await asServiceRole(c, async () => {
      const fileId = (
        await q("select id from public.fin_raw_remittance_files where file_sha256 = 'sha-1'")
      ).rows[0].id;
      await expect(
        q("select public.ins_commit_remittance($1, $2, $3, '{}'::jsonb, '[]'::jsonb)", [
          orgA,
          fileId,
          alice,
        ]),
      ).rejects.toThrow(/cannot be committed/);
    });
  });

  it("skips lines it already holds when the same advice arrives in a different file", async () => {
    await asServiceRole(c, async () => {
      const fileId = await newFile(orgA, "sha-2");
      const rows = reconciled();
      const res = (
        await q("select public.ins_commit_remittance($1, $2, $3, $4::jsonb, $5::jsonb) as r", [
          orgA,
          fileId,
          alice,
          JSON.stringify({ remittance_ref: "RM-1" }),
          asJson(rows),
        ])
      ).rows[0].r;
      expect(res).toMatchObject({ lines: 0, duplicates_skipped: rows.length });
      expect(
        (
          await q("select count(*)::int as n from public.ins_remittance_lines where org_id = $1", [
            orgA,
          ])
        ).rows[0].n,
      ).toBe(rows.length);
    });
  });

  it("is atomic: a bad line rolls the whole commit back and leaves the file committable", async () => {
    await asServiceRole(c, async () => {
      const fileId = await newFile(orgA, "sha-3");
      const rows = reconciled()
        .slice(0, 2)
        .map((r, i) => ({ ...r, line_key: `atomic|${i}` }));
      rows[1] = { ...rows[1], match_status: "bogus" as never };
      await q("begin");
      const failed = await q(
        "select public.ins_commit_remittance($1, $2, $3, '{}'::jsonb, $4::jsonb)",
        [orgA, fileId, alice, asJson(rows)],
      ).then(
        () => false,
        () => true,
      );
      await q("rollback");
      expect(failed).toBe(true);
      expect(
        (await q("select status from public.fin_raw_remittance_files where id = $1", [fileId]))
          .rows[0].status,
      ).toBe("validated");
      expect(
        (
          await q(
            "select count(*)::int as n from public.ins_remittance_lines where line_key like 'atomic|%'",
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  it("refuses a file that belongs to another organisation", async () => {
    await asServiceRole(c, async () => {
      const fileB = await newFile(orgB, "sha-b");
      await expect(
        q("select public.ins_commit_remittance($1, $2, $3, '{}'::jsonb, '[]'::jsonb)", [
          orgA,
          fileB,
          alice,
        ]),
      ).rejects.toThrow(/not found/);
    });
  });

  it("refuses a line that points at another organisation's claim", async () => {
    await asServiceRole(c, async () => {
      const claimB = (
        await q(
          "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code) values ($1, 'CA-B', 'INV-B', '1') returning id",
          [orgB],
        )
      ).rows[0].id;
      const fileId = await newFile(orgA, "sha-4");
      const rows = reconciled()
        .slice(0, 1)
        .map((r) => ({ ...r, line_key: "cross|1", claim_activity_id: claimB }));
      await q("begin");
      const failed = await q(
        "select public.ins_commit_remittance($1, $2, $3, '{}'::jsonb, $4::jsonb)",
        [orgA, fileId, alice, asJson(rows)],
      ).then(
        () => false,
        () => true,
      );
      await q("rollback");
      expect(failed).toBe(true);
    });
  });

  it("blocks a second upload of the same bytes", async () => {
    await asServiceRole(c, async () => {
      await expect(
        q(
          "insert into public.fin_raw_remittance_files (org_id, file_sha256) values ($1, 'sha-1')",
          [orgA],
        ),
      ).rejects.toThrow();
      await q(
        "insert into public.fin_raw_remittance_files (org_id, file_sha256) values ($1, 'sha-1')",
        [orgB],
      ); // another org: fine
    });
  });
});
