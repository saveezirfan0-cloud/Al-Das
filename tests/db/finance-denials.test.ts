/**
 * Denial management, database side: fin_sync_denial_cases opens, refreshes and recovers cases idempotently, reads the
 * taxonomy and the default deadline from the reference tables (same answers as lib/finance/denials.ts on the shared
 * fixture), and never crosses organisations. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays } from "@/lib/documents/expiry";

import fixture from "../unit/finance/fixtures/phase18-denials.synthetic.json";
import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 18: denial cases", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const sync = async (org: string, limit = 1000) =>
    (await q("select public.fin_sync_denial_cases($1, $2) as r", [org, limit])).rows[0].r as Record<
      string,
      unknown
    >;
  const claim = async (
    org: string,
    no: string,
    over: {
      code?: string | null;
      rejected?: number | null;
      remit?: string | null;
      first?: string | null;
      tx?: string | null;
    } = {},
  ) =>
    (
      await q(
        "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, first_remittance_date, last_remittance_date, net, remitted, rejected, last_denial_code, clinician_id) values ($1, $2, 'INV-' || $2, '99213', 'PAYER-D', $3, $4, $5, 100, 50, $6, $7, 'DHA-D1') returning id",
        [
          org,
          no,
          over.tx === undefined ? "2026-09-01" : over.tx,
          over.first === undefined ? null : over.first,
          over.remit === undefined ? "2026-09-20" : over.remit,
          over.rejected === undefined ? 50 : over.rejected,
          over.code === undefined ? "AUTH-001" : over.code,
        ],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("does nothing until finance sets the start date", async () => {
    await asServiceRole(c, async () => {
      await claim(orgA, "CA-OFF-1");
      expect(await sync(orgA)).toMatchObject({ skipped: "not_enabled", opened: 0 });
      expect(
        (
          await q("select count(*)::int as n from public.ins_denial_cases where org_id = $1", [
            orgA,
          ])
        ).rows[0].n,
      ).toBe(0);
    });
  });

  it("gives the same category, owner and deadline as the TypeScript lookup, for every fixture code", async () => {
    await asServiceRole(c, async () => {
      await q("delete from public.ins_claim_activities where org_id = $1", [orgA]);
      await q("delete from public.fin_ref_denial_codes where org_id = $1", [orgA]);
      for (const t of fixture.taxonomy)
        await q(
          "insert into public.fin_ref_denial_codes (org_id, code, is_family, description, category, default_owner_role, resubmit_days, appealable, active) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [
            orgA,
            t.code,
            t.isFamily,
            t.description,
            t.category,
            t.defaultOwnerRole,
            t.resubmitDays,
            t.appealable,
            t.active,
          ],
        );
      await q(
        "update public.fin_ref_finance_settings set denial_cases_start_date = '2026-08-01', denial_default_resubmit_days = $2 where org_id = $1",
        [orgA, fixture.defaultResubmitDays],
      );
      let n = 0;
      for (const l of fixture.lookups) await claim(orgA, `CA-LK-${++n}`, { code: l.code });
      expect(await sync(orgA)).toMatchObject({ opened: fixture.lookups.length });
      n = 0;
      for (const l of fixture.lookups) {
        const { rows } = await q(
          "select category, owner_role, denied_on::text, deadline_on::text, appealable from public.ins_denial_cases where org_id = $1 and claim_number = $2",
          [orgA, `CA-LK-${++n}`],
        );
        expect(rows[0].category, String(l.code)).toBe(l.expectCategory);
        expect(rows[0].owner_role, String(l.code)).toBe(l.expectOwner);
        expect(rows[0].deadline_on, String(l.code)).toBe(addDays(rows[0].denied_on, l.expectDays));
      }
    });
  });

  it("is idempotent, and a second run opens nothing", async () => {
    await asServiceRole(c, async () => {
      expect(await sync(orgA)).toMatchObject({ opened: 0, recovered: 0 });
      expect(
        (
          await q("select count(*)::int as n from public.ins_denial_cases where org_id = $1", [
            orgA,
          ])
        ).rows[0].n,
      ).toBe(fixture.lookups.length);
    });
  });

  it("takes the remittance date as the denial date, else the first remittance, else the claim date; ignores older ones", async () => {
    await asServiceRole(c, async () => {
      await claim(orgA, "CA-D-LAST", { remit: "2026-09-25", first: "2026-09-10" });
      await claim(orgA, "CA-D-FIRST", { remit: null, first: "2026-09-10" });
      await claim(orgA, "CA-D-TX", { remit: null, first: null, tx: "2026-09-02" });
      await claim(orgA, "CA-D-OLD", { remit: "2026-07-31", tx: "2026-07-01" }); // before the start date
      await claim(orgA, "CA-D-NODATE", { remit: null, first: null, tx: null });
      await claim(orgA, "CA-D-NOREJ", { rejected: 0 });
      await claim(orgA, "CA-D-NULLREJ", { rejected: null });
      expect(await sync(orgA)).toMatchObject({ opened: 3 });
      const got = (
        await q(
          "select claim_number, denied_on::text as d from public.ins_denial_cases where claim_number like 'CA-D-%' order by 1",
        )
      ).rows;
      expect(got).toEqual([
        { claim_number: "CA-D-FIRST", d: "2026-09-10" },
        { claim_number: "CA-D-LAST", d: "2026-09-25" },
        { claim_number: "CA-D-TX", d: "2026-09-02" },
      ]);
    });
  });

  it("refreshes amounts on a live case and recovers it when the rejected amount goes", async () => {
    await asServiceRole(c, async () => {
      const id = await claim(orgA, "CA-REC-1", { rejected: 50 });
      await sync(orgA);
      await q("update public.ins_claim_activities set rejected = 30, net = 90 where id = $1", [id]);
      expect(await sync(orgA)).toMatchObject({ refreshed: 1 });
      expect(
        (
          await q(
            "select rejected_amount::float as r, claim_net::float as n from public.ins_denial_cases where claim_activity_id = $1",
            [id],
          )
        ).rows[0],
      ).toEqual({ r: 30, n: 90 });
      await q("update public.ins_claim_activities set rejected = 0 where id = $1", [id]);
      expect(await sync(orgA)).toMatchObject({ recovered: 1 });
      const row = (
        await q(
          "select status, resolved_at is not null as done from public.ins_denial_cases where claim_activity_id = $1",
          [id],
        )
      ).rows[0];
      expect(row).toEqual({ status: "recovered", done: true });
      // a recovered case is not reopened by the next run
      expect(await sync(orgA)).toMatchObject({ opened: 0 });
    });
  });

  it("does not reopen a case the team closed for the same denial, but opens a new one for a later denial", async () => {
    await asServiceRole(c, async () => {
      const id = await claim(orgA, "CA-CLOSED-1", { remit: "2026-09-15" });
      await sync(orgA);
      await q(
        "update public.ins_denial_cases set status = 'lost', resolved_at = now(), resolution = 'payer upheld' where claim_activity_id = $1",
        [id],
      );
      expect(await sync(orgA)).toMatchObject({ opened: 0 });
      await q(
        "update public.ins_claim_activities set last_remittance_date = '2026-10-05' where id = $1",
        [id],
      ); // denied again later
      expect(await sync(orgA)).toMatchObject({ opened: 1 });
      expect(
        (
          await q(
            "select count(*)::int as n from public.ins_denial_cases where claim_activity_id = $1",
            [id],
          )
        ).rows[0].n,
      ).toBe(2);
      // at most one live case per claim
      await expect(
        q(
          "insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, denied_on, deadline_on) values ($1, $2, 'x', '2026-10-06', '2026-11-01')",
          [orgA, id],
        ),
      ).rejects.toThrow();
    });
  });

  it("caps how many cases one run opens", async () => {
    await asServiceRole(c, async () => {
      for (let i = 0; i < 5; i++) await claim(orgA, `CA-CAP-${i}`);
      expect(await sync(orgA, 2)).toMatchObject({ opened: 2 });
      expect(await sync(orgA, 2)).toMatchObject({ opened: 2 });
      expect(await sync(orgA, 2)).toMatchObject({ opened: 1 });
    });
  });

  it("never touches another organisation, and requires a start date there too", async () => {
    await asServiceRole(c, async () => {
      await claim(orgB, "CA-B-1");
      expect(await sync(orgA)).toMatchObject({ opened: 0 });
      expect(
        (
          await q("select count(*)::int as n from public.ins_denial_cases where org_id = $1", [
            orgB,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect(await sync(orgB)).toMatchObject({ skipped: "not_enabled" });
      // a case cannot point at another org's claim
      const claimB = (
        await q("select id from public.ins_claim_activities where org_id = $1 limit 1", [orgB])
      ).rows[0].id;
      await expect(
        q(
          "insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, denied_on, deadline_on) values ($1, $2, 'x', '2026-10-06', '2026-11-01')",
          [orgA, claimB],
        ),
      ).rejects.toThrow();
    });
  });

  it("requires a resolved time on a closed case and a deadline that is not before the denial", async () => {
    await asServiceRole(c, async () => {
      const id = await claim(orgA, "CA-CHK-1", { remit: "2026-09-16" });
      await q("update public.ins_claim_activities set rejected = 10 where id = $1", [id]);
      await sync(orgA);
      await expect(
        q(
          "update public.ins_denial_cases set status = 'won' where claim_activity_id = $1 and status = 'open'",
          [id],
        ),
      ).rejects.toThrow();
      await expect(
        q(
          "update public.ins_denial_cases set deadline_on = '2000-01-01' where claim_activity_id = $1",
          [id],
        ),
      ).rejects.toThrow();
    });
  });
});
