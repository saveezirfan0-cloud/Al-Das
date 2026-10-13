/**
 * Phase 20J: the Unite invoice-change register (fin_invoice_changes) and its reviews. Change events derived from synthetic
 * invoice deliveries (first receipt with a discount, a later discount rise with a net reduction, a credit note, a
 * cancellation, an invoice first seen cancelled, a write-off, refunds), the period and time-zone rules, decreases that are
 * not changes, other orgs excluded, a stable change_key that moves with the amount, who reads reviews (and that nobody writes
 * them directly), service-role-only access, the lock flag and the permission migration. Synthetic data only.
 * Needs TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { changeKpi, parseChanges, type ChangeEvent } from "@/lib/finance/invoice-changes";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type Rec = {
  discount?: number | null;
  credit_note?: number | null;
  write_off?: number | null;
  net: number;
  is_deleted?: boolean;
  created_by?: string | null;
  modified_by?: string | null;
};

describe.skipIf(!TEST_DATABASE_URL)("Invoice-change register (Phase 20J)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const inv: Record<string, string> = {};
  const pay: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);

  const invoice = async (org: string, no: string, txDate: string, invType = "SELF PAID") =>
    (
      await q(
        `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, doctor_dha_id, inv_type, net, total, patient_pin, record_hash)
         values ($1, $2, $3, 'P', 'DHA-SYN-1', $4, 0, 0, 'PIN-SYN-1', 'h') returning id`,
        [org, no, txDate, invType],
      )
    ).rows[0].id as string;
  const deliver = async (org: string, id: string, version: number, at: string, r: Rec) =>
    q(
      "insert into public.fin_invoice_versions (org_id, invoice_id, version, received_at, record) values ($1, $2, $3, $4, $5::jsonb)",
      [
        org,
        id,
        version,
        at,
        JSON.stringify({
          gross: 500,
          discount: r.discount ?? null,
          credit_note: r.credit_note ?? null,
          write_off: r.write_off ?? null,
          net: r.net,
          is_deleted: r.is_deleted ?? false,
          created_by: r.created_by ?? null,
          modified_by: r.modified_by ?? null,
        }),
      ],
    );
  const payment = async (
    org: string,
    id: string,
    key: string,
    refund: number,
    refundDate: string | null,
    current = true,
  ) =>
    (
      await q(
        "insert into public.fin_payments (org_id, invoice_id, payment_key, paid, paid_date, refund, refund_date, is_current) values ($1, $2, $3, 0, '2026-10-01', $4, $5, $6) returning id",
        [org, id, key, refund, refundDate, current],
      )
    ).rows[0].id as string;

  const register = async (from = "2026-10-01", to = "2026-10-31", org = () => orgA) =>
    parseChanges(
      (await svc(() => q("select public.fin_invoice_changes($1, $2, $3) as r", [org(), from, to])))
        .rows[0].r,
    );
  const brief = (e: ChangeEvent) => ({
    invoice: e.invoiceNo,
    kind: e.kind,
    amount: e.amount,
    date: e.changeDate,
    user: e.uniteUser,
  });
  const sortBrief = (events: ChangeEvent[]) =>
    events
      .map(brief)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.invoice.localeCompare(b.invoice) ||
          a.kind.localeCompare(b.kind),
      );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "ceo", "ops", "billing", "md", "ins"])
      users[n] = await createAuthUser(c, `${n}-changes@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fin", "Finance");
      await member("ceo", "CEO");
      await member("ops", "Operations");
      await member("billing", "Billing");
      await member("md", "Medical Director");
      await member("ins", "Insurance");

      // INV-1: discount on first receipt, an unchanged re-delivery, a discount rise with lines removed, a credit note
      inv.one = await invoice(orgA, "SYN-INV-1", "2026-10-02");
      await deliver(orgA, inv.one, 1, "2026-10-02T06:00:00Z", {
        discount: 50,
        net: 450,
        created_by: "unite.alice",
      });
      await deliver(orgA, inv.one, 1, "2026-10-03T06:00:00Z", {
        discount: 50,
        net: 450,
        created_by: "unite.alice",
      });
      await deliver(orgA, inv.one, 2, "2026-10-05T06:00:00Z", {
        discount: 80,
        net: 380,
        created_by: "unite.alice",
        modified_by: "unite.bob",
      });
      // 21:30 UTC on 7 Oct is 01:30 on 8 Oct in Dubai: the change is dated in the clinic's time zone
      await deliver(orgA, inv.one, 3, "2026-10-07T21:30:00Z", {
        discount: 80,
        net: 380,
        credit_note: 25,
        created_by: "unite.alice",
        modified_by: "unite.bob",
      });
      // INV-2: cancelled on the second delivery (only the cancellation, not also an "amount reduced")
      inv.two = await invoice(orgA, "SYN-INV-2", "2026-10-03");
      await deliver(orgA, inv.two, 1, "2026-10-03T06:00:00Z", { discount: 0, net: 300 });
      await deliver(orgA, inv.two, 2, "2026-10-06T06:00:00Z", {
        net: 0,
        is_deleted: true,
        modified_by: "unite.carol",
      });
      // INV-3: first seen already cancelled, with a discount: one cancellation only
      inv.three = await invoice(orgA, "SYN-INV-3", "2026-10-04");
      await deliver(orgA, inv.three, 1, "2026-10-04T06:00:00Z", {
        discount: 20,
        net: 200,
        is_deleted: true,
        created_by: "unite.dave",
      });
      // INV-4: a write-off on the second delivery; refunds: current in the period, not current, outside the period
      inv.four = await invoice(orgA, "SYN-INV-4", "2026-10-04", "INSURANCE");
      await deliver(orgA, inv.four, 1, "2026-10-04T06:00:00Z", { net: 600 });
      await deliver(orgA, inv.four, 2, "2026-10-09T06:00:00Z", { net: 600, write_off: 60 });
      pay.refund = await payment(orgA, inv.four, "SYN-INV-4|1|R1", 120, "2026-10-10");
      await payment(orgA, inv.four, "SYN-INV-4|1|", 120, "2026-10-10", false);
      await payment(orgA, inv.four, "SYN-INV-4|2|R2", 40, "2026-09-20");
      // INV-5: raised in September; a discount cut in October is not a change; the later rise is
      inv.five = await invoice(orgA, "SYN-INV-5", "2026-09-15");
      await deliver(orgA, inv.five, 1, "2026-09-15T06:00:00Z", { discount: 10, net: 490 });
      await deliver(orgA, inv.five, 2, "2026-10-11T06:00:00Z", { discount: 5, net: 495 });
      await deliver(orgA, inv.five, 3, "2026-10-12T06:00:00Z", {
        discount: 15,
        net: 485,
        modified_by: "unite.bob",
      });
      // org B: a discount and a refund that org A must never see
      inv.b = await invoice(orgB, "SYN-INV-B", "2026-10-02");
      await deliver(orgB, inv.b, 1, "2026-10-02T06:00:00Z", { discount: 99, net: 401 });
      await payment(orgB, inv.b, "SYN-INV-B|1|R", 77, "2026-10-02");
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("change events", () => {
    it("derives every discount, credit note, write-off, net reduction, cancellation and refund of the period", async () => {
      const reg = await register();
      expect(sortBrief(reg.events)).toEqual([
        {
          invoice: "SYN-INV-1",
          kind: "discount",
          amount: 50,
          date: "2026-10-02",
          user: "unite.alice",
        },
        {
          invoice: "SYN-INV-3",
          kind: "cancellation",
          amount: 200,
          date: "2026-10-04",
          user: "unite.dave",
        },
        {
          invoice: "SYN-INV-1",
          kind: "discount",
          amount: 30,
          date: "2026-10-05",
          user: "unite.bob",
        },
        {
          invoice: "SYN-INV-1",
          kind: "net_reduction",
          amount: 40,
          date: "2026-10-05",
          user: "unite.bob",
        },
        {
          invoice: "SYN-INV-2",
          kind: "cancellation",
          amount: 300,
          date: "2026-10-06",
          user: "unite.carol",
        },
        {
          invoice: "SYN-INV-1",
          kind: "credit_note",
          amount: 25,
          date: "2026-10-08",
          user: "unite.bob",
        },
        { invoice: "SYN-INV-4", kind: "write_off", amount: 60, date: "2026-10-09", user: null },
        { invoice: "SYN-INV-4", kind: "refund", amount: 120, date: "2026-10-10", user: null },
        {
          invoice: "SYN-INV-5",
          kind: "discount",
          amount: 10,
          date: "2026-10-12",
          user: "unite.bob",
        },
      ]);
      const refund = reg.events.find((e) => e.kind === "refund")!;
      expect(refund).toMatchObject({
        branch: "P",
        doctorId: "DHA-SYN-1",
        invType: "INSURANCE",
        review: null,
      });
      expect(reg).toMatchObject({ startDate: null, minAmount: 0, bulkMax: 0 });
    });

    it("keeps to the period: first-receipt changes by transaction date, later ones by delivery date", async () => {
      expect(
        sortBrief((await register("2026-10-01", "2026-10-05")).events).map((e) => [
          e.invoice,
          e.kind,
        ]),
      ).toEqual([
        ["SYN-INV-1", "discount"],
        ["SYN-INV-3", "cancellation"],
        ["SYN-INV-1", "discount"],
        ["SYN-INV-1", "net_reduction"],
      ]);
      // September: INV-5's first-receipt discount and the September refund; nothing of October
      expect(sortBrief((await register("2026-09-01", "2026-09-30")).events)).toEqual([
        { invoice: "SYN-INV-5", kind: "discount", amount: 10, date: "2026-09-15", user: null },
        { invoice: "SYN-INV-4", kind: "refund", amount: 40, date: "2026-09-20", user: null },
      ]);
      expect((await register("2026-11-01", "2026-11-30")).events).toEqual([]);
    });

    it("never shows another org's changes", async () => {
      const a = await register();
      expect(a.events.some((e) => e.invoiceNo === "SYN-INV-B")).toBe(false);
      const b = await register("2026-10-01", "2026-10-31", () => orgB);
      expect(sortBrief(b.events).map((e) => [e.invoice, e.kind, e.amount])).toEqual([
        ["SYN-INV-B", "discount", 99],
        ["SYN-INV-B", "refund", 77],
      ]);
    });

    it("gives each change a stable key, the same whatever the period queried", async () => {
      const one = await register();
      const two = await register();
      expect(two.events.map((e) => e.changeKey)).toEqual(one.events.map((e) => e.changeKey));
      expect(new Set(one.events.map((e) => e.changeKey)).size).toBe(one.events.length);
      const narrow = await register("2026-10-05", "2026-10-05");
      for (const e of narrow.events)
        expect(
          one.events.find((x) => x.changeKey === e.changeKey),
          e.kind,
        ).toBeTruthy();
      for (const e of one.events) expect(e.changeKey).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe("reviews", () => {
    let discountKey: string;
    beforeAll(async () => {
      const reg = await register();
      const e = reg.events.find(
        (x) => x.invoiceNo === "SYN-INV-1" && x.kind === "discount" && x.amount === 50,
      )!;
      discountKey = e.changeKey;
      await svc(async () => {
        await q(
          "insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason, reviewed_by) values ($1, $2, $3, 'discount', 50, '2026-10-02', 'approved', 'Synthetic approval', $4)",
          [orgA, discountKey, inv.one, users.ops],
        );
        // org B's own review of its own change
        const b = await register("2026-10-01", "2026-10-31", () => orgB);
        await q(
          "insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason) values ($1, $2, $3, 'discount', 99, '2026-10-02', 'rejected', 'Synthetic')",
          [orgB, b.events.find((x) => x.kind === "discount")!.changeKey, inv.b],
        );
      });
    });

    it("attaches a review to exactly its change", async () => {
      const reg = await register();
      const reviewed = reg.events.filter((e) => e.review !== null);
      expect(reviewed.map((e) => e.changeKey)).toEqual([discountKey]);
      expect(reviewed[0].review).toMatchObject({
        decision: "approved",
        reason: "Synthetic approval",
        bulk: false,
        monthLocked: false,
        reviewedBy: users.ops,
      });
    });

    it("a refund whose amount changes gets a new key, so the old review no longer covers it", async () => {
      const before = (await register()).events.find((e) => e.kind === "refund")!;
      await svc(() =>
        q(
          "insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason) values ($1, $2, $3, 'refund', 120, '2026-10-10', 'approved', 'Synthetic')",
          [orgA, before.changeKey, inv.four],
        ),
      );
      expect((await register()).events.find((e) => e.kind === "refund")!.review?.decision).toBe(
        "approved",
      );
      await svc(() => q("update public.fin_payments set refund = 150 where id = $1", [pay.refund]));
      const after = (await register()).events.find((e) => e.kind === "refund")!;
      expect(after.amount).toBe(150);
      expect(after.changeKey).not.toBe(before.changeKey);
      expect(after.review).toBeNull();
      await svc(() => q("update public.fin_payments set refund = 120 where id = $1", [pay.refund]));
      expect((await register()).events.find((e) => e.kind === "refund")!.changeKey).toBe(
        before.changeKey,
      );
    });

    it("the measure counts from the start date, at or above the minimum amount, unreviewed or not approved", async () => {
      await svc(() =>
        q(
          "update public.fin_ref_finance_settings set change_review_start_date = '2026-10-05', change_review_min_amount = 30, change_bulk_approve_max = 100 where org_id = $1",
          [orgA],
        ),
      );
      const reg = await register();
      expect(reg).toMatchObject({ startDate: "2026-10-05", minAmount: 30, bulkMax: 100 });
      // from 5 Oct, at least 30, no approval: discount 30, net reduction 40, cancellation 300, write-off 60
      // (the refund of 120 is approved; the credit note of 25 and the discount of 10 are below 30)
      expect(changeKpi(reg)).toEqual({
        measured: true,
        from: "2026-10-05",
        awaiting: { count: 4, amount: 430 },
        rejected: { count: 0, amount: 0 },
        unapproved: { count: 4, amount: 430 },
      });
      await svc(() =>
        q(
          "update public.fin_ref_finance_settings set change_review_start_date = null, change_review_min_amount = 0, change_bulk_approve_max = 0 where org_id = $1",
          [orgA],
        ),
      );
    });

    it("Finance, the CEO and Operations read their own org's reviews; Billing, Insurance and the Medical Director none", async () => {
      const seen = (who: string) =>
        asRole(who, async () =>
          Number(
            (await q("select count(*)::int as n from public.fin_invoice_change_reviews")).rows[0].n,
          ),
        );
      for (const who of ["fin", "ceo", "ops", "alice"]) expect(await seen(who), who).toBe(2);
      for (const who of ["billing", "ins", "md"]) expect(await seen(who), who).toBe(0);
      expect(await seen("bob")).toBe(1); // org B's own row only
    });

    it("nobody writes reviews directly, not even Operations or Finance", async () => {
      const e = (await register()).events.find((x) => x.kind === "cancellation")!;
      const insert = (who: string) =>
        asRole(who, () =>
          q(
            "insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason) values ($1, $2, $3, 'cancellation', 300, '2026-10-06', 'approved', 'x')",
            [orgA, e.changeKey, inv.two],
          ),
        );
      // Finance can read the invoice, so only row level security stops it; Operations cannot even see the invoice
      await expect(insert("fin")).rejects.toMatchObject({ code: "42501" });
      await expect(insert("ops")).rejects.toMatchObject({
        code: expect.stringMatching(/^(42501|23514)$/),
      });
      expect(
        (
          await asRole("fin", () =>
            q("update public.fin_invoice_change_reviews set decision = 'approved'"),
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await asRole("ops", () => q("delete from public.fin_invoice_change_reviews"))).rowCount,
      ).toBe(0);
    });

    it("one review per change, bounded reason and decision, never pointing at another org's invoice", async () => {
      const ins = (
        org: string,
        key: string,
        invoiceId: string,
        decision = "approved",
        reason = "Synthetic",
      ) =>
        svc(() =>
          q(
            "insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason) values ($1, $2, $3, 'discount', 1, '2026-10-02', $4, $5)",
            [org, key, invoiceId, decision, reason],
          ),
        );
      await expect(ins(orgA, discountKey, inv.one)).rejects.toMatchObject({ code: "23505" });
      const fresh = "0".repeat(32);
      await expect(ins(orgA, fresh, inv.b)).rejects.toMatchObject({ code: "23514" });
      await expect(ins(orgA, fresh, inv.one, "waved_through")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(ins(orgA, fresh, inv.one, "approved", " ")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(ins(orgA, fresh, inv.one, "approved", "x".repeat(501))).rejects.toMatchObject({
        code: "23514",
      });
      await expect(ins(orgA, "not-a-key", inv.one)).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("the register runs for the service role only", async () => {
    const { rows } = await q(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fin_invoice_changes'`,
    );
    expect(rows).toEqual([
      { anon: false, auth: false, svc: true, definer: true, config: ['search_path=""'] },
    ]);
    await expect(
      asRole("fin", () =>
        q("select public.fin_invoice_changes($1, '2026-10-01', '2026-10-31')", [orgA]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("flags changes in a locked month", async () => {
    await svc(() =>
      q(
        `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
         values ($1, '2026-10-01', 'locked', '{}'::jsonb, 'h', now(), now(), now(), now())`,
        [orgA],
      ),
    );
    const oct = await register();
    expect(oct.events.every((e) => e.monthLocked)).toBe(true);
    expect((await register("2026-09-01", "2026-09-30")).events.some((e) => e.monthLocked)).toBe(
      false,
    );
  });

  it("the migration grants the change keys to Finance, the CEO and Operations only, idempotently, and creates the Operations role", async () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261031000100_finance_invoice_changes.sql"),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    const role = /insert into public\.roles[\s\S]*?on conflict \(org_id, name\) do nothing;/.exec(
      sql,
    )?.[0];
    expect(block, "the grant block was not found").toBeTruthy();
    expect(role, "the role insert was not found").toBeTruthy();
    const orgC = await createOrg(c, "Org C", "org-c", users.alice);
    await svc(async () => {
      for (const [name, system] of [
        ["Finance", true],
        ["CEO", true],
        ["Billing", true],
        ["Insurance", true],
        ["Custom finance", false],
      ] as const)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '[\"finance.view\"]'::jsonb, $3)",
          [orgC, name, system],
        );
    });
    const read = async () =>
      Object.fromEntries(
        (
          await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
        ).rows.map((r) => [
          r.name,
          (r.permissions as string[]).filter((p) => p.startsWith("finance.changes.")).sort(),
        ]),
      );
    await svc(() => q(role!));
    await svc(() => q(block!));
    const first = await read();
    expect(first).toMatchObject({
      Finance: ["finance.changes.review", "finance.changes.view"],
      CEO: ["finance.changes.view"],
      Operations: ["finance.changes.review", "finance.changes.view"],
      Billing: [],
      Insurance: [],
      "Custom finance": [],
    });
    await svc(() => q(role!));
    await svc(() => q(block!));
    expect(await read()).toEqual(first);
    // the new role matches the code preset and is a system role
    const ops = (
      await svc(() =>
        q(
          "select permissions, is_system, description from public.roles where org_id = $1 and name = 'Operations'",
          [orgC],
        ),
      )
    ).rows[0];
    const preset = FINANCE_ROLES.find((r) => r.name === "Operations")!;
    expect(ops).toEqual({
      permissions: preset.permissions,
      is_system: true,
      description: preset.description,
    });
  });
});
