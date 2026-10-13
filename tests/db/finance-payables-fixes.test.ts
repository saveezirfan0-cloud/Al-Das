/**
 * Phase 20D review fixes, database side (migration 20261107000100_finance_fixes_payables.sql):
 *   1. a locked month freezes CONTENT, not the Tally export columns: an item dated in a locked month can still be exported
 *   2. ... nor the status: last month's invoice can be put on this month's voucher, paid or released
 *   3. a browser (user-client) write to fin_ref_finance_settings may change only the Phase 18 columns the workflow
 *      settings page writes; every other column (Phase 20 controls, and any future column) is refused
 *   4. the maker of a voucher never records its payment (Pulse and Tally approval modes)
 *   5. part payments: a voucher pays its invoices oldest first; an invoice is paid only when its balance is settled
 *   6. read scope: a department head reads only the Tier 2 vouchers waiting for one or that they decided (and their
 *      documents); special categories need a checker, CEO or compensation key; inbox files need an inbox or payables
 *      manager
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES, permissionMatches } from "@/lib/auth/permissions";
import {
  allocateVoucherPayment,
  canReadVoucher,
  voucherReadAccess,
  type SpecialCategory,
} from "@/lib/finance/vouchers";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (n: number) => (n + 0x5000).toString(16).padStart(64, "0");
const OCT = "2026-10-05";
const PAY = { date: "2026-10-08", reference: "BANKREF-FIX" };

describe.skipIf(!TEST_DATABASE_URL)("Finance payables fixes (Phase 20D review)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let supplier: string;
  const users: Record<string, string> = {};
  const rolePerms: Record<string, readonly string[]> = {};
  let docSeq = 1;
  let invSeq = 1;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const as = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint;
  const failure = (sql: string, params: unknown[] = []) =>
    q(sql, params).then(
      () => null,
      (x: unknown) => x,
    );

  const doc = (opts: { inbox?: boolean } = {}) =>
    svc(async () => {
      const { rows } = await q(
        "insert into public.fin_documents (org_id, kind, storage_path, mime_type, size_bytes, sha256, status, inbox_at) values ($1::uuid, $2, $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 1000, $3, 'ready', $4) returning id",
        [
          orgA,
          opts.inbox ? "unclassified" : "voucher_backup",
          sha(docSeq++),
          opts.inbox ? new Date().toISOString() : null,
        ],
      );
      return rows[0].id as string;
    });

  const invoice = (date: string, net: number, vat = 0) =>
    svc(async () => {
      const { rows } = await q(
        "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat) values ($1, $2, $3, $4, 'Consumables', $5, $6) returning id",
        [orgA, supplier, `INV-FIX-${String(invSeq++).padStart(3, "0")}`, date, net, vat],
      );
      return rows[0].id as string;
    });

  const fields = (over: Record<string, unknown> = {}) => ({
    voucher_date: OCT,
    payee_name: "Supplier Test Fix",
    supplier_id: "",
    amount: 100,
    category: "Consumables",
    special_category: "none",
    branch_code: "P",
    cost_centre: "",
    pay_from: "BANK-MAIN",
    payment_method: "bank_transfer",
    narration: "Synthetic voucher (fixes)",
    ...over,
  });

  const save = (
    user: string,
    id: string | null,
    f: Record<string, unknown>,
    docs: string[] = [],
    invoices: string[] = [],
  ) =>
    svc(async () => {
      const { rows } = await q(
        "select public.fin_voucher_save($1, $2, $3, $4::jsonb, $5::uuid[], $6::uuid[]) as r",
        [orgA, users[user], id, JSON.stringify(f), invoices, docs],
      );
      return rows[0].r as { id: string; status: string };
    });

  const act = (
    id: string,
    user: string,
    action: string,
    opts: { remarks?: string; payment?: unknown } = {},
  ) =>
    svc(async () => {
      const h = (
        await q("select content_sha256 from public.fin_payment_vouchers where id = $1", [id])
      ).rows[0]?.content_sha256 as string | null;
      const { rows } = await q(
        "select public.fin_voucher_act($1, $2, $3, $4, $5, $6, $7::jsonb) as r",
        [
          orgA,
          id,
          users[user],
          action,
          h,
          opts.remarks ?? null,
          opts.payment ? JSON.stringify(opts.payment) : null,
        ],
      );
      return rows[0].r as { to: string };
    });

  /** The resulting status, or the HINT code (SQLSTATE when there is none). */
  const outcome = async (fn: () => Promise<{ to?: string; status?: string }>) => {
    try {
      const r = await fn();
      return r.to ?? r.status ?? "?";
    } catch (e) {
      return hint(e) ?? code(e) ?? "error";
    }
  };

  /** A Tier 1 voucher taken to "approved" (maker prepares and submits, the Finance Manager verifies). */
  const approved = async (f: Record<string, unknown>, invoices: string[] = []) => {
    const v = await save("maker", null, fields(f), [await doc()], invoices);
    await act(v.id, "maker", "submit");
    await act(v.id, "fm", "check");
    return v.id;
  };

  const lockMonth = (month: string) =>
    svc(async () => {
      const id = (
        await q("select public.fin_close_store_snapshot($1, $2, $3, '{}'::jsonb) as id", [
          orgA,
          month,
          users.fm,
        ])
      ).rows[0].id as string;
      const h = (await q("select snapshot_hash from public.fin_period_closes where id = $1", [id]))
        .rows[0].snapshot_hash;
      await q("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
        orgA,
        id,
        users.fm,
        h,
      ]);
      await q("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [orgA, id, users.ceo, h]);
    });

  const invoiceRow = (id: string) =>
    svc(
      async () =>
        (
          await q(
            "select status, paid_amount::float8 as paid, total::float8 as total, tally_export_id from public.fin_supplier_invoices where id = $1",
            [id],
          )
        ).rows[0] as {
          status: string;
          paid: number;
          total: number;
          tally_export_id: string | null;
        },
    );

  // Created before February 2026 is locked (beforeAll).
  let febInvoice: string;
  let febInvoiceToPay: string;
  let febInvoiceToRelease: string;
  let febVoucher: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "maker", "fm", "dept", "dept2", "ceo", "exporter", "cost"])
      users[n] = await createAuthUser(c, `${n}-payfix@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-payfix", users.alice);
    orgB = await createOrg(c, "Org B", "org-b-payfix", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Tally exporter', '', '[\"finance.tally.export\"]'::jsonb, false)",
        [orgA],
      );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("maker", "Finance");
      await member("fm", "Finance Manager");
      await member("dept", "Department head");
      await member("dept2", "Department head");
      await member("ceo", "CEO");
      await member("exporter", "Tally exporter");
      await member("cost", "Cost / Payroll");
      supplier = (
        await q(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Supplier Test Fix') returning id",
          [orgA],
        )
      ).rows[0].id as string;
    });
    for (const r of FINANCE_ROLES) rolePerms[r.name] = r.permissions;
    rolePerms["Tally exporter"] = ["finance.tally.export"];

    febInvoice = await invoice("2026-02-10", 400, 20);
    febInvoiceToPay = await invoice("2026-02-11", 300);
    febInvoiceToRelease = await invoice("2026-02-12", 250);
    febVoucher = await approved({ voucher_date: "2026-02-12", amount: 75 });
    await lockMonth("2026-02-01");
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 1. Locked month: the Tally export columns are not content
  // -------------------------------------------------------------------------------------------------------------------
  it("exports a voucher and a supplier invoice dated in a locked month, and still freezes their content", async () => {
    const exported = await svc(async () => {
      try {
        const r = await q(
          "select public.fin_tally_record_export($1, $2, $3::uuid[], $4::uuid[], $5, '<ENVELOPE/>', 495) as id",
          [orgA, users.maker, [febVoucher], [febInvoice], "d".repeat(64)],
        );
        return r.rows[0].id as string;
      } catch (e) {
        return `error:${hint(e) ?? code(e)}`;
      }
    });
    expect(exported).toMatch(/^[0-9a-f-]{36}$/);
    expect((await invoiceRow(febInvoice)).tally_export_id).toBe(exported);
    // content stays frozen by the lock, for every role
    for (const [sql, id] of [
      ["update public.fin_supplier_invoices set net = 1 where id = $1", febInvoice],
      [
        "update public.fin_supplier_invoices set invoice_date = '2026-02-15' where id = $1",
        febInvoiceToPay,
      ],
      ["update public.fin_supplier_invoices set status = 'void' where id = $1", febInvoiceToPay],
      ["delete from public.fin_supplier_invoices where id = $1", febInvoiceToPay],
      ["update public.fin_payment_vouchers set amount = 76 where id = $1", febVoucher],
      ["update public.fin_payment_vouchers set narration = 'changed' where id = $1", febVoucher],
    ] as const) {
      const err = await svc(() => failure(sql, [id]));
      expect(hint(err), sql).toBe("month_locked");
    }
    // a new item dated in the locked month is still refused
    const err = await svc(() =>
      failure(
        "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net) values ($1, $2, 'INV-FIX-LOCK', '2026-02-20', 'Consumables', 10)",
        [orgA, supplier],
      ),
    );
    expect(code(err)).toBe("42501");
    // and the locked voucher's own steps stay refused (its lock is by its own date)
    expect(await outcome(() => act(febVoucher, "fm", "pay", { payment: PAY }))).toBe(
      "month_locked",
    );
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 2. Locked month: status moves are not content
  // -------------------------------------------------------------------------------------------------------------------
  it("puts last month's (locked) invoice on this month's voucher, pays it, and releases one when a voucher is cancelled", async () => {
    const v = await save("maker", null, fields({ amount: 300 }), [await doc()], [febInvoiceToPay]);
    expect((await invoiceRow(febInvoiceToPay)).status).toBe("on_voucher");
    expect(await outcome(() => act(v.id, "maker", "submit"))).toBe("submitted");
    expect(await outcome(() => act(v.id, "fm", "check"))).toBe("approved");
    expect(await outcome(() => act(v.id, "fm", "pay", { payment: PAY }))).toBe("paid");
    expect(await invoiceRow(febInvoiceToPay)).toMatchObject({ status: "paid", paid: 300 });

    const w = await save(
      "maker",
      null,
      fields({ amount: 250 }),
      [await doc()],
      [febInvoiceToRelease],
    );
    expect((await invoiceRow(febInvoiceToRelease)).status).toBe("on_voucher");
    expect(await outcome(() => act(w.id, "maker", "cancel", { remarks: "Duplicate" }))).toBe(
      "cancelled",
    );
    expect((await invoiceRow(febInvoiceToRelease)).status).toBe("open");
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 3. Settings: a browser write reaches only the Phase 18 columns
  // -------------------------------------------------------------------------------------------------------------------
  it("refuses a user-client write to any settings column outside the Phase 18 allow-list (and any future column)", async () => {
    const update = (user: string, set: string) =>
      as(user, () =>
        failure(`update public.fin_ref_finance_settings set ${set} where org_id = $1`, [orgA]),
      );
    for (const set of [
      "approval_mode = 'tally'",
      "voucher_large_amount = 1",
      "voucher_mismatch_tolerance = 999",
      "bank_auto_accept_score = 50",
      "bank_amount_tolerance = 999",
      "change_review_min_amount = 999999",
      "followup_start_date = '2026-01-01'",
      "recovery_enabled = true",
      "close_deadline_wd = 20",
    ]) {
      const err = await update("fm", set);
      expect(code(err), set).toBe("42501");
    }
    // the Phase 18 workflow settings page still writes its own columns with the member's client
    expect(await update("fm", "denial_warn_days = 9, doctor_basis = 'performing'")).toBeNull();
    // the service role (Phase 20 settings actions, after can()) is not limited by the trigger
    expect(
      await svc(() =>
        failure(
          "update public.fin_ref_finance_settings set voucher_large_amount = 60000 where org_id = $1",
          [orgA],
        ),
      ),
    ).toBeNull();
    const row = (
      await svc(() =>
        q(
          "select approval_mode, denial_warn_days, voucher_large_amount::float8 as large from public.fin_ref_finance_settings where org_id = $1",
          [orgA],
        ),
      )
    ).rows[0];
    expect(row).toEqual({ approval_mode: "pulse", denial_warn_days: 9, large: 60000 });

    // insert: only defaults outside the allow-list
    await svc(() => q("delete from public.fin_ref_finance_settings where org_id = $1", [orgA]));
    const ins = (cols: string, vals: string) =>
      as("fm", () =>
        failure(`insert into public.fin_ref_finance_settings (org_id${cols}) values ($1${vals})`, [
          orgA,
        ]),
      );
    expect(code(await ins(", approval_mode", ", 'tally'"))).toBe("42501");
    expect(code(await ins(", bank_auto_accept_score", ", 50"))).toBe("42501");
    expect(await ins(", denial_warn_days", ", 8")).toBeNull();

    // fail closed for a column added later
    await q("begin");
    try {
      await q(
        "alter table public.fin_ref_finance_settings add column zz_future_control integer not null default 0",
      );
      await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: users.fm, role: "authenticated" }),
      ]);
      const err = await failure(
        "update public.fin_ref_finance_settings set zz_future_control = 1 where org_id = $1",
        [orgA],
      );
      expect(code(err)).toBe("42501");
    } finally {
      await q("rollback");
    }
  });

  it("the allow-list is exactly the columns the workflow settings actions write with the member's own client", async () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../app/(app)/finance/workflow-settings/actions.ts"),
      "utf8",
    );
    const userClientColumns = new Set<string>();
    for (const fn of src.split(/\nexport async function /).slice(1)) {
      const m =
        /createClient\(\)\s*\)\s*\.from\("fin_ref_finance_settings"\)\s*\.update\(\{([\s\S]*?)\}\)/.exec(
          fn,
        );
      if (!m) continue;
      for (const k of m[1].matchAll(/^\s*([a-z_0-9]+):/gm)) userClientColumns.add(k[1]);
    }
    const allowed = (await q("select app.fin_settings_user_columns() as cols")).rows[0]
      .cols as string[];
    expect(userClientColumns.size).toBeGreaterThan(20);
    expect([...userClientColumns].sort()).toEqual(allowed.filter((x) => x !== "updated_at").sort());
    // no Phase 20 control column is browser-writable
    for (const col of [
      "approval_mode",
      "voucher_mismatch_tolerance",
      "bank_auto_accept_score",
      "followup_start_date",
      "change_review_min_amount",
      "recovery_enabled",
    ])
      expect(allowed, col).not.toContain(col);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 4. The maker never records the payment
  // -------------------------------------------------------------------------------------------------------------------
  it("refuses the voucher's maker recording its payment, in Pulse and in Tally approval mode", async () => {
    const pulse = await approved({ amount: 120 });
    expect(await outcome(() => act(pulse, "maker", "pay", { payment: PAY }))).toBe("same_person");
    expect(await outcome(() => act(pulse, "fm", "pay", { payment: PAY }))).toBe("paid");

    await svc(() =>
      q("update public.fin_ref_finance_settings set approval_mode = 'tally' where org_id = $1", [
        orgA,
      ]),
    );
    try {
      const v = await save("maker", null, fields({ amount: 30000 }), [await doc()]);
      expect(await outcome(() => act(v.id, "maker", "submit"))).toBe("for_tally");
      expect(await outcome(() => act(v.id, "maker", "pay", { payment: PAY }))).toBe("same_person");
      expect(await outcome(() => act(v.id, "fm", "pay", { payment: PAY }))).toBe("paid");
    } finally {
      await svc(() =>
        q("update public.fin_ref_finance_settings set approval_mode = 'pulse' where org_id = $1", [
          orgA,
        ]),
      );
    }
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 5. Part payments
  // -------------------------------------------------------------------------------------------------------------------
  it("pays part of an invoice, keeps the balance open for a later voucher, and refuses a voucher above the balance", async () => {
    // the Board pack's unpaid supplier invoices at the end of October (payments are dated 8 October)
    const unpaid = async () =>
      (
        await svc(() =>
          q(
            "select public.fin_close_controls($1, '2026-10-01', '2026-10-31') -> 'payables' -> 'invoices_unpaid' as u",
            [orgA],
          ),
        )
      ).rows[0].u as { count: number; amount: number };
    const inv = await invoice("2026-09-01", 1000, 50); // 1,050.00
    const first = await approved({ amount: 500 }, [inv]);
    const before = await unpaid();
    expect(await outcome(() => act(first, "fm", "pay", { payment: PAY }))).toBe("paid");
    expect(await invoiceRow(inv)).toMatchObject({ status: "open", paid: 500, total: 1050 });
    // the pack counts the 550.00 balance, not nothing
    expect(await unpaid()).toEqual({ count: before.count, amount: before.amount - 500 });
    // a part-paid invoice cannot be voided
    const err = await svc(() =>
      failure("update public.fin_supplier_invoices set status = 'void' where id = $1", [inv]),
    );
    expect(hint(err)).toBe("wrong_status");
    // the balance is 550.00: 552.00 is more than the balance plus the 1.00 tolerance
    const tooMuch = await save("maker", null, fields({ amount: 552 }), [await doc()], [inv]);
    expect(await outcome(() => act(tooMuch.id, "maker", "submit"))).toBe("amount_exceeds_invoices");
    expect(await outcome(() => act(tooMuch.id, "maker", "cancel", { remarks: "Too much" }))).toBe(
      "cancelled",
    );
    // 549.50 settles it within the tolerance
    const second = await approved({ amount: 549.5 }, [inv]);
    expect(await outcome(() => act(second, "fm", "pay", { payment: PAY }))).toBe("paid");
    expect(await invoiceRow(inv)).toMatchObject({ status: "paid", paid: 1049.5 });
    expect(await unpaid()).toEqual({ count: before.count - 1, amount: before.amount - 1050 });
    const links = (
      await svc(() =>
        q(
          "select voucher_id, paid_amount::float8 as paid from public.fin_voucher_invoices where supplier_invoice_id = $1",
          [inv],
        ),
      )
    ).rows;
    expect(Object.fromEntries(links.map((l) => [l.voucher_id, l.paid]))).toEqual({
      [first]: 500,
      [second]: 549.5,
      [tooMuch.id]: null,
    });
  });

  it("allocates a voucher across its invoices oldest first, exactly like allocateVoucherPayment()", async () => {
    const newer = await invoice("2026-09-20", 300);
    const older = await invoice("2026-09-05", 1050);
    const sameDay = await invoice("2026-09-05", 80);
    const v = await approved({ amount: 1100 }, [newer, older, sameDay]);
    const before = (
      await svc(() =>
        q(
          "select id, invoice_date::text as date, invoice_number as number, total::float8 as total, paid_amount::float8 as paid from public.fin_supplier_invoices where id = any($1::uuid[])",
          [[newer, older, sameDay]],
        ),
      )
    ).rows as Array<{ id: string; date: string; number: string; total: number; paid: number }>;
    const expected = allocateVoucherPayment(1100, before, 1);
    expect(await outcome(() => act(v, "fm", "pay", { payment: PAY }))).toBe("paid");
    const after = (
      await svc(() =>
        q(
          "select si.id, si.status, si.paid_amount::float8 as paid, l.paid_amount::float8 as allocated from public.fin_supplier_invoices si join public.fin_voucher_invoices l on l.supplier_invoice_id = si.id and l.voucher_id = $2 where si.id = any($1::uuid[])",
          [[newer, older, sameDay], v],
        ),
      )
    ).rows;
    expect(
      Object.fromEntries(
        after.map((r) => [r.id, { allocated: r.allocated, paid: r.paid, status: r.status }]),
      ),
    ).toEqual(
      Object.fromEntries(
        expected.map((e) => [
          e.id,
          { allocated: e.allocated, paid: e.paidAfter, status: e.status },
        ]),
      ),
    );
    // older (1,050) is paid in full, then the same-day one (80, by invoice number), the newer one gets nothing
    expect(expected.map((e) => [e.id, e.allocated])).toEqual([
      [older, 1050],
      [sameDay, 50],
      [newer, 0],
    ]);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // 6. Read scope
  // -------------------------------------------------------------------------------------------------------------------
  describe("who reads which voucher and document", () => {
    const v: Record<string, string> = {};
    const d: Record<string, string> = {};

    beforeAll(async () => {
      const mk = async (key: string, amount: number, special = "none") => {
        d[key] = await doc();
        const r = await save("maker", null, fields({ amount, special_category: special }), [
          d[key],
        ]);
        v[key] = r.id;
        return r.id;
      };
      await act(await mk("t2waiting", 8000), "maker", "submit");
      await act(v.t2waiting, "fm", "check");
      await act(await mk("t2decided", 9000), "maker", "submit");
      await act(v.t2decided, "fm", "check");
      await act(v.t2decided, "dept", "approve_dept");
      await act(await mk("t2submitted", 7000), "maker", "submit");
      await act(await mk("t1", 300), "maker", "submit");
      await act(await mk("payroll", 900, "payroll"), "maker", "submit");
      await act(v.payroll, "fm", "check");
      await act(await mk("related", 6000, "related_party"), "maker", "submit");
      await act(v.related, "fm", "check");
      d.inbox = await doc({ inbox: true });
    });

    const sees = (u: string, table: string, id: string, col = "id") =>
      as(
        u,
        async () => (await q(`select 1 from public.${table} where ${col} = $1`, [id])).rowCount,
      );

    it("a department head reads only Tier 2 vouchers waiting for a department head or decided by them, and their documents", async () => {
      expect(await sees("dept", "fin_payment_vouchers", v.t2waiting)).toBe(1);
      expect(await sees("dept", "fin_payment_vouchers", v.t2decided)).toBe(1);
      expect(await sees("dept2", "fin_payment_vouchers", v.t2decided)).toBe(0); // decided by someone else
      for (const k of ["t2submitted", "t1", "payroll", "related"])
        expect(await sees("dept", "fin_payment_vouchers", v[k]), k).toBe(0);
      expect(await sees("dept", "fin_documents", d.t2waiting)).toBe(1);
      expect(await sees("dept", "fin_voucher_documents", v.t2waiting, "voucher_id")).toBe(1);
      expect(await sees("dept", "fin_voucher_events", v.t2waiting, "voucher_id")).toBeGreaterThan(
        0,
      );
      for (const k of ["t1", "payroll", "related", "inbox"])
        expect(await sees("dept", "fin_documents", d[k]), k).toBe(0);
      expect(await sees("dept", "fin_voucher_events", v.payroll, "voucher_id")).toBe(0);
    });

    it("special categories need the checker, CEO or compensation key; inbox files need an inbox or payables manager", async () => {
      for (const k of ["payroll", "related"]) {
        expect(await sees("exporter", "fin_payment_vouchers", v[k]), k).toBe(0);
        expect(await sees("exporter", "fin_documents", d[k]), k).toBe(0);
        expect(await sees("exporter", "fin_voucher_events", v[k], "voucher_id"), k).toBe(0);
        expect(await sees("exporter", "fin_voucher_documents", v[k], "voucher_id"), k).toBe(0);
        for (const u of ["maker", "fm", "ceo"]) {
          expect(await sees(u, "fin_payment_vouchers", v[k]), `${u} ${k}`).toBe(1);
          expect(await sees(u, "fin_documents", d[k]), `${u} ${k}`).toBe(1);
        }
      }
      expect(await sees("exporter", "fin_payment_vouchers", v.t1)).toBe(1);
      expect(await sees("exporter", "fin_documents", d.t1)).toBe(1);
      for (const u of ["exporter", "dept", "ceo", "cost"])
        expect(await sees(u, "fin_documents", d.inbox), u).toBe(0);
      for (const u of ["maker", "fm"]) expect(await sees(u, "fin_documents", d.inbox), u).toBe(1);
      expect(await sees("cost", "fin_payment_vouchers", v.payroll)).toBe(0);
      expect(await sees("bob", "fin_payment_vouchers", v.t1)).toBe(0);
    });

    it("canReadVoucher() (the server read path) agrees with row level security for every person and voucher", async () => {
      const all = (
        await svc(() =>
          q(
            "select v.id, v.special_category, v.route, v.needs_dept, v.status, coalesce((select array_agg(e.actor_id::text) from public.fin_voucher_events e where e.voucher_id = v.id and e.action in ('dept_approved', 'rejected')), '{}') as deciders from public.fin_payment_vouchers v where v.org_id = $1",
            [orgA],
          ),
        )
      ).rows;
      expect(all.length).toBeGreaterThanOrEqual(7);
      const roleOf: Record<string, string> = {
        maker: "Finance",
        fm: "Finance Manager",
        dept: "Department head",
        dept2: "Department head",
        ceo: "CEO",
        exporter: "Tally exporter",
        cost: "Cost / Payroll",
      };
      for (const [u, role] of Object.entries(roleOf)) {
        const access = voucherReadAccess((p) =>
          rolePerms[role].some((g) => permissionMatches(g, p)),
        );
        const visible = new Set(
          (
            await as(u, () =>
              q("select id from public.fin_payment_vouchers where org_id = $1", [orgA]),
            )
          ).rows.map((r) => r.id as string),
        );
        for (const r of all)
          expect(
            canReadVoucher(
              access,
              {
                special: r.special_category as SpecialCategory,
                route: r.route,
                needsDept: !!r.needs_dept,
                status: r.status,
                deciders: r.deciders as string[],
              },
              users[u],
            ),
            `${u} ${r.id} ${r.special_category} ${r.status}`,
          ).toBe(visible.has(r.id));
      }
    });
  });

  it("another organisation reads none of it", async () => {
    expect(
      await as("bob", async () =>
        Number(
          (
            await q(
              "select count(*)::int as n from public.fin_payment_vouchers where org_id = $1",
              [orgA],
            )
          ).rows[0].n,
        ),
      ),
    ).toBe(0);
    expect(orgB).toBeTruthy();
  });
});
