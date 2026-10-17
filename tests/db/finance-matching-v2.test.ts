/**
 * Matching engine v2 (insurer payments), in the database and end to end: the reference key parity with the TypeScript
 * helper, every guard the database enforces (a deposit is never allocated beyond its amount, an item never beyond its
 * total, a closed item takes nothing, a write-off is exactly the remainder, a decision is only ever undone), who may read
 * and that nobody writes directly; then the loader and the server actions run against the real tables (the supabase
 * client is replaced by tests/db/pg-admin.ts): suggestions, an automatic rule that fires only when switched on, accept
 * and undo, the Finance Manager's gate, and the monthly bank run leaving settled items alone. Synthetic data only.
 * Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { REF_KEY_FIXTURES } from "@/lib/finance/match-keys";

import {
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";
import { createPgAdmin } from "./pg-admin";

const state = vi.hoisted(() => ({
  client: null as unknown,
  actor: "fin",
  users: {} as Record<string, string>,
  orgId: "",
  permissions: {} as Record<string, string[]>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireMember: async () => ({
    userId: state.users[state.actor],
    orgId: state.orgId,
    roleId: "r",
    roleName: state.actor,
    status: "active" as const,
    permissions: state.permissions[state.actor] ?? [],
    org: { name: "Test", timezone: "Asia/Dubai", settings: {}, is_training: false },
    profile: { first_name: "T", last_name: "U" },
    user: { email: "t@example.test" },
    orgs: [],
  }),
}));
vi.mock("@/lib/supabase/admin", async () => {
  const { createPgAdmin: make } = await import("./pg-admin");
  return { createAdminClient: () => make(state.client as Client) };
});

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; message?: string }) => e,
  );

describe.skipIf(!TEST_DATABASE_URL)("Insurer payment matching (matching engine v2)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let orgC: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const fake = () => createPgAdmin(c);
  const ids: Record<string, string> = {}; // bank lines and items by name, org A
  const idsC: Record<string, string> = {}; // org C

  /** One insurance bank account, a statement, a receipt register and two remittance batches. */
  async function seedInsurance(org: string, tag: string, out: Record<string, string>) {
    const acc = (
      await q(
        "insert into public.fin_bank_accounts (org_id, name, bank_name, last4, receives_insurance) values ($1, 'Insurance', 'Synthetic Bank', '1111', true) returning id",
        [org],
      )
    ).rows[0].id;
    out.account = acc;
    await q("select public.fin_bank_import($1, 'bank_statement', $2, null, null, 's.csv', $3, $4::jsonb, $5)", [
      org,
      acc,
      `stmt-${tag}-${org}`,
      JSON.stringify([
        { value_date: "2026-10-05", amount: 1000, reference: "RA-0001", description: "PAYERX SETTLEMENT" },
        { value_date: "2026-10-10", amount: 1000, reference: "TRF9", description: "PAYERX BULK" },
        { value_date: "2026-10-11", amount: 250, reference: "RA-0004", description: "PAYERY ADVICE" },
        { value_date: "2026-10-12", amount: -40, reference: "FEE", description: "BANK CHARGE" },
        { value_date: "2026-10-13", amount: 75.5, reference: "X77", description: "UNKNOWN SENDER" },
      ]),
      users.fin,
    ]);
    for (const [name, ref] of [["L1", "RA-0001"], ["L2", "TRF9"], ["L3", "RA-0004"], ["L4", "FEE"], ["L5", "X77"]])
      out[name] = (
        await q("select id from public.fin_bank_lines where org_id = $1 and reference = $2", [org, ref])
      ).rows[0].id;
    await q("select public.fin_receipts_import($1, null, 'r.csv', $2, $3::jsonb, $4)", [
      org,
      `rcpt-${tag}-${org}`,
      JSON.stringify([
        { payment_ref: "RA-0001", amount: 1000, receipt_date: "2026-10-01", payer: "payerx" },
        { payment_ref: "RA-0002", amount: 600, receipt_date: "2026-10-02", payer: "PAYERX" },
        { payment_ref: "RA-0003", amount: 400, receipt_date: "2026-10-03", payer: "PAYERX" },
        { payment_ref: "RA-0004", amount: 250, receipt_date: "2026-10-04", payer: "PAYERY" },
      ]),
      users.fin,
    ]);
    // the remittance advice for RA-0004 (joins the receipt by reference key) and a batch without a reference
    out.batch4 = (
      await q(
        "insert into public.ins_remittance_batches (org_id, remittance_ref, payer_id, paid_on, sum_paid, created_at) values ($1, 'RA 0004', 'PAYERY', '2026-10-04', 250, '2026-10-06T00:00:00Z') returning id",
        [org],
      )
    ).rows[0].id;
    out.batch5 = (
      await q(
        "insert into public.ins_remittance_batches (org_id, remittance_ref, payer_id, paid_on, sum_paid, created_at) values ($1, null, 'PAYERZ', '2026-10-06', 75.50, '2026-10-06T00:00:00Z') returning id",
        [org],
      )
    ).rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    state.client = c;
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "fm", "billing"])
      users[n] = await createAuthUser(c, `${n}-match@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    orgC = await createOrg(c, "Org C", "org-c", users.alice);
    state.orgId = orgA;
    state.users = users;
    for (const r of FINANCE_ROLES) {
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
        [orgA, r.name, r.description, JSON.stringify(r.permissions)],
      );
      state.permissions[r.name] = r.permissions as string[];
    }
    state.permissions.fin = state.permissions["Finance"];
    state.permissions.fm = state.permissions["Finance Manager"];
    state.permissions.billing = state.permissions["Billing"];
    for (const [u, role] of [["fin", "Finance"], ["fm", "Finance Manager"], ["billing", "Billing"]])
      await q(
        "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
        [orgA, users[u], role],
      );
    await seedInsurance(orgA, "a", ids);
    await seedInsurance(orgC, "c", idsC);
    // a second account that does not receive insurance, for the guard tests (the loader ignores it)
    ids.guardAccount = (
      await q(
        "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Guards', 'Synthetic Bank', '2222') returning id",
        [orgA],
      )
    ).rows[0].id;
    await q("select public.fin_bank_import($1, 'bank_statement', $2, null, null, 'g.csv', $3, $4::jsonb, $5)", [
      orgA,
      ids.guardAccount,
      `guards-${orgA}`,
      JSON.stringify([
        { value_date: "2026-09-01", amount: 100, reference: "G1", description: "SYNTHETIC" },
        { value_date: "2026-09-02", amount: 50, reference: "G2", description: "SYNTHETIC" },
        { value_date: "2026-09-03", amount: -40, reference: "GD", description: "SYNTHETIC" },
      ]),
      users.fin,
    ]);
    for (const n of ["G1", "G2", "GD"])
      ids[n] = (await q("select id from public.fin_bank_lines where org_id = $1 and reference = $2", [orgA, n])).rows[0].id;
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  // ---------------------------------------------------------------------------
  it("the SQL reference key equals the TypeScript one on every shared fixture", async () => {
    for (const [input, expected] of REF_KEY_FIXTURES) {
      const r = await q("select public.fin_ref_key($1) as k", [input]);
      expect(r.rows[0].k, JSON.stringify(input)).toBe(expected);
    }
  });

  // ---------------------------------------------------------------------------
  describe("what the database refuses", () => {
    const decide = (line: string, item: string, total: number, amount: number, rule = "manual") =>
      q(
        "insert into public.fin_match_decisions (org_id, bank_line_id, item_ref, item_total, amount, rule, decision, decided_by) values ($1, $2, $3, $4, $5, $6, 'accepted', $7) returning id",
        [orgA, ids[line], item, total, amount, rule, users.fin],
      );
    const close = (item: string, total: number, kind: string, amount: number, reason = "insurer_short_paid") =>
      q(
        "insert into public.fin_item_closures (org_id, item_ref, item_total, kind, amount, reason_code, decided_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [orgA, item, total, kind, amount, reason, users.fin],
      );
    let firstId: string;

    it("allocates part of a deposit, then refuses more than the deposit holds", async () => {
      firstId = (await decide("G1", "ins|G1X", 80, 60)).rows[0].id;
      const e = await err(decide("G1", "ins|G2X", 80, 50)); // 60 + 50 > 100
      expect(e?.code).toBe("23514");
      expect(e?.message).toMatch(/already allocated/);
    });

    it("refuses more than the item's total, and an amount above the total it was decided with", async () => {
      const e = await err(decide("G2", "ins|G1X", 80, 30)); // 60 + 30 > 80
      expect(e?.message).toMatch(/already paid/);
      expect((await err(decide("G2", "ins|G9X", 80, 90)))?.code).toBe("23514");
    });

    it("refuses to allocate a debit", async () => {
      expect((await err(decide("GD", "ins|G3X", 100, 10)))?.message).toMatch(/only a credit/);
    });

    it("pays one item from several deposits and one deposit to several items", async () => {
      await decide("G2", "ins|G1X", 80, 20); // completes G1X: 60 + 20
      await decide("G1", "ins|G5X", 100, 40); // G1: 60 + 40 = 100, its whole amount
      const used = await q(
        "select coalesce(sum(amount), 0)::float8 as s from public.fin_match_decisions where bank_line_id = $1 and undone_at is null",
        [ids.G1],
      );
      expect(used.rows[0].s).toBe(100);
    });

    it("closes an item only as a write-off of exactly the remainder, or a cancellation with nothing allocated", async () => {
      expect((await err(close("ins|G3X", 100, "write_off", 99)))?.message).toMatch(/exactly the remainder/);
      await close("ins|G3X", 100, "write_off", 100);
      // an item with money allocated cannot be cancelled
      await decide("G2", "ins|G4X", 40, 10);
      expect((await err(close("ins|G4X", 40, "cancelled", 0)))?.message).toMatch(/cannot be cancelled/);
      // a written-off remainder: G5X had 40 of 100 allocated
      expect((await err(close("ins|G5X", 100, "write_off", 100)))?.message).toMatch(/exactly the remainder/);
      await close("ins|G5X", 100, "write_off", 60);
    });

    it("a closed item takes no more money until it is reopened", async () => {
      // G2 has 50 - 20 - 10 = 20 left
      expect((await err(decide("G2", "ins|G3X", 100, 10)))?.message).toMatch(/closed/);
      expect((await err(close("ins|G3X", 100, "write_off", 100)))?.code).toBe("23505"); // one active closure per item
    });

    it("a decision cannot be edited or deleted, and is undone once", async () => {
      expect((await err(q("update public.fin_match_decisions set amount = 61 where id = $1", [firstId])))?.message).toMatch(/cannot be edited/);
      expect((await err(q("delete from public.fin_match_decisions where id = $1", [firstId])))?.code).toBe("42501");
      await q("update public.fin_match_decisions set undone_at = now(), undone_by = $2 where id = $1", [firstId, users.fin]);
      expect(
        (await err(q("update public.fin_match_decisions set undone_at = now() + interval '1 day' where id = $1", [firstId])))?.message,
      ).toMatch(/already undone/);
    });

    it("a closure cannot be edited or deleted either", async () => {
      const id = (await q("select id from public.fin_item_closures where item_ref = 'ins|G3X'")).rows[0].id;
      expect((await err(q("update public.fin_item_closures set amount = 1 where id = $1", [id])))?.message).toMatch(/cannot be edited/);
      expect((await err(q("delete from public.fin_item_closures where id = $1", [id])))?.code).toBe("42501");
    });

    it("nobody signed in writes these tables directly, whatever their role", async () => {
      for (const sql of [
        "insert into public.fin_match_decisions (org_id, bank_line_id, item_ref, item_total, amount, rule, decision) values ($1, $2, 'ins|NOPE', 10, 5, 'manual', 'accepted')",
        "insert into public.fin_payer_aliases (org_id, payer_key, alias) values ($1, 'X', 'ABC DEF')",
        "insert into public.fin_match_rule_status (org_id, rule, auto_enabled) values ($1, 'reference', true)",
        "insert into public.fin_item_closures (org_id, item_ref, item_total, kind, amount, reason_code) values ($1, 'ins|NOPE', 10, 'cancelled', 0, 'duplicate_entry')",
        "insert into public.fin_receipts (org_id, import_id, row_no, payment_ref, ref_key, amount, receipt_date) values ($1, gen_random_uuid(), 1, 'A', 'A', 1, now())",
      ])
        for (const who of ["fin", "fm", "alice"]) {
          const e = await asUser(c, users[who], () => err(q(sql, [orgA, ids.G1])));
          expect(e?.code, `${who}: ${sql.slice(0, 40)}`).toBe("42501");
        }
      const e = await asUser(c, users.fin, () =>
        err(q("select public.fin_receipts_import($1, null, 'x', 'x', '[]'::jsonb, $2)", [orgA, users.fin])),
      );
      expect(e?.code).toBe("42501");
    });
  });

  // ---------------------------------------------------------------------------
  describe("who reads", () => {
    const rows = (user: string, table: string, org = orgA) =>
      asUser(c, users[user], async () => (await q(`select count(*)::int as n from public.${table} where org_id = $1`, [org])).rows[0].n);

    it("Finance and the Finance Manager read; Billing and another organisation do not", async () => {
      for (const t of ["fin_receipts", "fin_match_decisions", "fin_item_closures", "fin_match_rule_status"]) {
        if (t === "fin_match_rule_status") await q("insert into public.fin_match_rule_status (org_id, rule) values ($1, 'reference') on conflict do nothing", [orgA]);
        expect(await rows("fin", t), `fin ${t}`).toBeGreaterThan(0);
        expect(await rows("fm", t), `fm ${t}`).toBeGreaterThan(0);
        expect(await rows("billing", t), `billing ${t}`).toBe(0);
        expect(await rows("bob", t), `bob ${t}`).toBe(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("loader and actions", () => {
    const actions = () => import("@/app/(app)/finance/matching/actions");
    const load = async () => {
      const { loadMatching } = await import("@/lib/finance/match-v2-server");
      return loadMatching(fake() as never, orgA, "2026-10-17");
    };
    const itemByLabel = (v: Awaited<ReturnType<typeof load>>, label: string) => v.items.find((i) => i.label === label)!;
    const suggestionFor = (v: Awaited<ReturnType<typeof load>>, line: string) => v.suggestions.find((s) => s.lineId === ids[line]);
    let fp: (o: unknown) => string;

    beforeAll(async () => {
      fp = (await import("@/lib/finance/match-v2-server")).optionFingerprint as never;
    });

    it("builds one list of insurer payments from the receipt register and the remittance advices", async () => {
      const v = await load();
      expect(v.account?.id).toBe(ids.account);
      expect(v.items.map((i) => i.label).sort()).toEqual(["RA-0001", "RA-0002", "RA-0003", "RA-0004", expect.stringMatching(/^Remittance batch /)].sort());
      const both = itemByLabel(v, "RA-0004");
      expect(both.source).toBe("both"); // receipt and advice joined by reference key
      expect(both.total).toBe(250);
      const lone = v.items.find((i) => i.ref === `ins|batch:${ids.batch5}`)!;
      expect(lone.source).toBe("remittance");
      expect(lone.total).toBe(75.5);
      expect(v.lines.map((l) => l.id).sort()).toEqual([ids.L1, ids.L2, ids.L3, ids.L5].sort()); // the debit is never a credit to explain
    });

    it("proposes by reference, ambiguously by payer and amount, and by amount and date, and matches nothing by itself", async () => {
      const v = await load();
      const l1 = suggestionFor(v, "L1")!;
      expect(l1.rule).toBe("reference");
      expect(l1.options).toHaveLength(1);
      expect(l1.options[0].allocations).toEqual([
        { lineId: ids.L1, itemRef: "ins|RA0001", amount: 1000, itemTotal: 1000 },
      ]);
      const l2 = suggestionFor(v, "L2")!;
      expect(l2.rule).toBe("payer_sum");
      expect(l2.options.length).toBeGreaterThan(1); // RA-0001 alone, or RA-0002 + RA-0003: a person chooses
      expect(suggestionFor(v, "L5")!.rule).toBe("amount_date");
      expect(v.suggestions.every((s) => !s.auto)).toBe(true);
    });

    it("runs matching without applying anything while every rule is off", async () => {
      const { runMatching } = await actions();
      state.actor = "fin";
      const r = await runMatching();
      expect(r).toMatchObject({ ok: true, data: { applied: 0 } });
      expect((await q("select count(*)::int as n from public.fin_match_decisions where org_id = $1 and bank_line_id = any($2)", [orgA, [ids.L1, ids.L2, ids.L3, ids.L5]])).rows[0].n).toBe(0);
    });

    it("a person without the permission is refused by every action", async () => {
      const a = await actions();
      state.actor = "billing";
      const denied = { ok: false, error: "You do not have permission for that." };
      expect(await a.runMatching()).toEqual(denied);
      expect(await a.undoDecision({ id: ids.L1 })).toEqual(denied);
      expect(await a.allocateManually({ lineId: ids.L1, itemRef: "ins|RA0001", amount: 1 })).toEqual(denied);
      state.actor = "fin"; // manage, but not approve
      expect(await a.setRuleAuto({ rule: "reference", enabled: true })).toEqual(denied);
      expect(await a.decideAlias({ id: ids.L1, decision: "approve" })).toEqual(denied);
      expect(await a.closeItem({ itemRef: "ins|RA0003", kind: "write_off", reasonCode: "insurer_short_paid" })).toEqual(denied);
      expect(await a.reopenItem({ id: ids.L1 })).toEqual(denied);
    });

    it("accepts exactly what was shown, and refuses a proposal that has changed", async () => {
      const a = await actions();
      state.actor = "fin";
      const v = await load();
      const s = suggestionFor(v, "L1")!;
      const stale = await a.acceptSuggestion({ lineId: ids.L1, rule: "reference", optionIndex: 0, expect: "ins|RA0001=999.00" });
      expect(stale.ok).toBe(false);
      const ok = await a.acceptSuggestion({ lineId: ids.L1, rule: "reference", optionIndex: 0, expect: fp(s.options[0]) });
      expect(ok.ok).toBe(true);
      const after = await load();
      expect(itemByLabel(after, "RA-0001")).toMatchObject({ status: "paid", open: 0, allocated: 1000 });
      expect(after.lines.some((l) => l.id === ids.L1)).toBe(false);
      // a second accept of the same proposal finds nothing to accept
      expect((await a.acceptSuggestion({ lineId: ids.L1, rule: "reference", optionIndex: 0, expect: fp(s.options[0]) })).ok).toBe(false);
      const d = (await q("select rule, auto, decision, amount::float8 as amount from public.fin_match_decisions where bank_line_id = $1", [ids.L1])).rows;
      expect(d).toEqual([{ rule: "reference", auto: false, decision: "accepted", amount: 1000 }]);
    });

    it("proposes the narrative words as a payer name, unused until a Finance Manager approves", async () => {
      const a = await actions();
      const names = (await q("select id, payer_key, alias, status from public.fin_payer_aliases where org_id = $1", [orgA])).rows;
      expect(names).toEqual([expect.objectContaining({ payer_key: "PAYERX", alias: "PAYERX SETTLEMENT", status: "proposed" })]);
      const v = await load();
      expect(v.aliases[0]).toMatchObject({ status: "proposed", made: 0 });
      state.actor = "fin";
      expect((await a.decideAlias({ id: names[0].id, decision: "approve" })).ok).toBe(false);
      state.actor = "fm";
      expect((await a.decideAlias({ id: names[0].id, decision: "approve" })).ok).toBe(true);
      expect((await a.decideAlias({ id: names[0].id, decision: "approve" })).ok).toBe(false); // already decided
      expect((await a.proposeAliasManually({ payerKey: "payerx", alias: "ab" })).ok).toBe(false);
      expect((await a.proposeAliasManually({ payerKey: "payerx", alias: "PAYERX BULK" })).ok).toBe(true);
      expect((await a.proposeAliasManually({ payerKey: "payerx", alias: "payerx   bulk" })).ok).toBe(false); // already listed
    });

    it("an automatic rule can be switched on only when its own record qualifies", async () => {
      const a = await actions();
      state.actor = "fm";
      // default thresholds: 20 decisions a month for 2 months
      const refused = await a.setRuleAuto({ rule: "reference", enabled: true });
      expect(refused.ok).toBe(false);
      expect((refused as { error: string }).error).toMatch(/Needs 2 months/);
      expect((await a.setRuleAuto({ rule: "payer_sum", enabled: true })).ok).toBe(false);
      // the thresholds are settings: loosen them for this organisation and the one accepted match is enough
      await q("update public.fin_ref_finance_settings set match_auto_min_decisions = 1, match_auto_min_months = 1, match_auto_min_precision = 50 where org_id = $1", [orgA]);
      const on = await a.setRuleAuto({ rule: "reference", enabled: true });
      expect(on.ok).toBe(true);
      const v = await load();
      expect(v.gates.find((g) => g.rule === "reference")).toMatchObject({ on: true, ok: true });
      expect(v.gates.find((g) => g.rule === "payer_sum")).toMatchObject({ on: false, ok: false });
    });

    it("now the exact reference match is automatic, and runMatching applies only that", async () => {
      const a = await actions();
      state.actor = "fin";
      const v = await load();
      expect(suggestionFor(v, "L3")).toMatchObject({ rule: "reference", auto: true });
      expect(suggestionFor(v, "L2")!.auto).toBe(false);
      expect(suggestionFor(v, "L5")!.auto).toBe(false);
      const r = await a.runMatching();
      expect(r).toMatchObject({ ok: true, data: { applied: 1, failed: 0 } });
      const d = (await q("select rule, auto from public.fin_match_decisions where bank_line_id = $1", [ids.L3])).rows;
      expect(d).toEqual([{ rule: "reference", auto: true }]);
      const after = await load();
      expect(itemByLabel(after, "RA-0004").status).toBe("paid");
      // nothing more to apply
      expect(await a.runMatching()).toMatchObject({ ok: true, data: { applied: 0 } });
    });

    it("after RA-0001 is paid, the payer set that remains is unambiguous but still waits for a person", async () => {
      const v = await load();
      const s = suggestionFor(v, "L2")!;
      expect(s.rule).toBe("payer_sum");
      expect(s.options).toHaveLength(1);
      expect(s.options[0].allocations.map((x) => x.itemRef).sort()).toEqual(["ins|RA0002", "ins|RA0003"]);
      expect(s.options[0].aliasId).toBeNull(); // recognised by the payer code itself: "PAYERX BULK" is only proposed
    });
  });
});
