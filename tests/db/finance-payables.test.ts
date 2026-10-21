/**
 * Phase 20D: payables and zero-paper approvals, database side. Who reads what (and that nobody writes directly), the
 * delegation-of-authority routing and the approval state machine in parity with the pure mirror (the shared synthetic
 * fixture), the content-hash parity with lib/finance/voucher-hash.ts, the append-only trail, Tier-1-only bulk checks, the
 * month lock, the atomic Tally export record and the migration's role grants. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { voucherCanonical, voucherContentHash } from "@/lib/finance/voucher-hash";
import { formatVoucherNumber, type SpecialCategory } from "@/lib/finance/vouchers";

import fixture from "../unit/finance/fixtures/phase20d-vouchers.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const STALE = "f".repeat(64);
const sha = (n: number) => n.toString(16).padStart(64, "0");

describe.skipIf(!TEST_DATABASE_URL)("Finance payables and vouchers (Phase 20D)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  let docSeq = 1;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const as = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint;

  /** A ready finance document (synthetic sha256), service role. */
  const doc = (org: string, kind = "voucher_backup") =>
    svc(async () => {
      const n = docSeq++;
      const { rows } = await q(
        "insert into public.fin_documents (org_id, kind, storage_path, mime_type, size_bytes, sha256, status) values ($1::uuid, $2, $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 1000, $3, 'ready') returning id",
        [org, kind, sha(n)],
      );
      return rows[0].id as string;
    });

  const fields = (over: Record<string, unknown> = {}) => ({
    voucher_date: fixture.voucherDate,
    payee_name: "Supplier Test 01",
    supplier_id: "",
    amount: 100,
    category: "Consumables",
    special_category: "none",
    branch_code: "P",
    cost_centre: "",
    pay_from: "BANK-MAIN",
    payment_method: "bank_transfer",
    narration: "Synthetic voucher",
    ...over,
  });

  const save = (
    org: string,
    user: string,
    id: string | null,
    f: Record<string, unknown>,
    docs: string[] = [],
    invoices: string[] = [],
  ) =>
    svc(async () => {
      const { rows } = await q(
        "select public.fin_voucher_save($1, $2, $3, $4::jsonb, $5::uuid[], $6::uuid[]) as r",
        [org, user, id, JSON.stringify(f), invoices, docs],
      );
      return rows[0].r as {
        id: string;
        voucher_no: string;
        status: string;
        returned_to_draft: boolean;
      };
    });

  const act = (
    org: string,
    id: string,
    user: string,
    action: string,
    opts: { hash?: string | null; remarks?: string; payment?: unknown } = {},
  ) =>
    svc(async () => {
      const hashNow =
        opts.hash !== undefined
          ? opts.hash
          : ((await q("select content_sha256 from public.fin_payment_vouchers where id = $1", [id]))
              .rows[0]?.content_sha256 as string | null);
      const { rows } = await q(
        "select public.fin_voucher_act($1, $2, $3, $4, $5, $6, $7::jsonb) as r",
        [
          org,
          id,
          user,
          action,
          hashNow,
          opts.remarks ?? null,
          opts.payment ? JSON.stringify(opts.payment) : null,
        ],
      );
      return rows[0].r as { to: string; from: string };
    });

  /** The step's result, or the error code the database put in the HINT (SQLSTATE when there is none). */
  const outcome = async (
    fn: () => Promise<{ to?: string; status?: string }>,
    ok: (r: { to?: string; status?: string }) => string,
  ) => {
    try {
      return ok(await fn());
    } catch (e) {
      return hint(e) ?? code(e) ?? "error";
    }
  };
  /** Runs a statement and returns its error (or null). Each statement is its own transaction. */
  const failure = (sql: string, params: unknown[] = []) =>
    q(sql, params).then(
      () => null,
      (x: unknown) => x,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "maker", "fm", "dept", "ceo", "billing", "md", "cost"])
      users[n] = await createAuthUser(c, `${n}-payables@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    users.admin = users.alice;
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
      await member("maker", "Finance");
      await member("fm", "Finance Manager");
      await member("dept", "Department head");
      await member("ceo", "CEO");
      await member("billing", "Billing");
      await member("md", "Medical Director");
      await member("cost", "Cost / Payroll");
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("seeds the directive's delegation of authority for every organisation", async () => {
    const { rows } = await svc(() =>
      q(
        "select code, special_category, min_amount::float8 as min, max_amount::float8 as max, needs_dept_head, needs_ceo, bulk_allowed from public.fin_ref_approval_tiers where org_id = $1 order by sort_order",
        [orgA],
      ),
    );
    expect(rows.map((r) => r.code)).toEqual(fixture.tiers.map((t) => t.code));
    for (const t of fixture.tiers) {
      const r = rows.find((x) => x.code === t.code)!;
      expect(
        {
          special: r.special_category,
          min: r.min,
          max: r.max,
          dept: r.needs_dept_head,
          ceo: r.needs_ceo,
          bulk: r.bulk_allowed,
        },
        t.code,
      ).toEqual({
        special: t.specialCategory,
        min: t.minAmount,
        max: t.maxAmount,
        dept: t.needsDeptHead,
        ceo: t.needsCeo,
        bulk: t.bulkAllowed,
      });
    }
    expect(
      (
        await svc(() =>
          q("select count(*)::int as n from public.fin_ref_approval_tiers where org_id = $1", [
            orgB,
          ]),
        )
      ).rows[0].n,
    ).toBe(7);
  });

  it("routes amounts and special categories like the pure rule (fixture parity)", async () => {
    for (const r of fixture.routing) {
      // app.* helpers are not callable by any API role; the test connection (the owner) calls it directly
      const { rows } = await q("select (app.fin_voucher_rule($1, $2::numeric, $3)).code as code", [
        orgA,
        r.amount,
        r.special,
      ]);
      expect(rows[0].code, `${r.amount} ${r.special}`).toBe(r.tier);
    }
  });

  it("numbers vouchers per organisation and year in the shared format", async () => {
    const d = await doc(orgB);
    const a = await save(orgB, users.bob, null, fields({ voucher_date: "2027-02-01" }), [d]);
    const b = await save(orgB, users.bob, null, fields({ voucher_date: "2027-03-01" }), [d]);
    expect([a.voucher_no, b.voucher_no]).toEqual([
      formatVoucherNumber(2027, 1),
      formatVoucherNumber(2027, 2),
    ]);
    const other = await save(orgA, users.maker, null, fields({ voucher_date: "2027-01-10" }));
    expect(other.voucher_no).toBe(formatVoucherNumber(2027, 1));
  });

  it("computes the same content text and hash as lib/finance/voucher-hash.ts", async () => {
    const supplier = (
      await svc(() =>
        q(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Supplier Test 09') returning id",
          [orgA],
        ),
      )
    ).rows[0].id as string;
    const d1 = await doc(orgA, "supplier_invoice");
    const d2 = await doc(orgA);
    const inv = (
      await svc(() =>
        q(
          "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat, document_id) values ($1, $2, 'INV-T-9', '2026-10-02', 'Consumables', 100, 5, $3) returning id",
          [orgA, supplier, d1],
        ),
      )
    ).rows[0].id as string;
    const narration = "Line one\nLine two \\ back, dash — and ü";
    const v = await save(
      orgA,
      users.maker,
      null,
      fields({ supplier_id: supplier, amount: 105, narration, cost_centre: "CC-1" }),
      [d2],
      [inv],
    );
    const { rows } = await svc(() =>
      q(
        "select v.*, public.fin_voucher_canonical(v.id) as canon, public.fin_voucher_compute_hash(v.id) as hash from public.fin_payment_vouchers v where v.id = $1",
        [v.id],
      ),
    );
    const r = rows[0];
    const docs = (
      await svc(() =>
        q("select sha256 from public.fin_documents where id = any($1::uuid[])", [[d1, d2]]),
      )
    ).rows.map((x) => x.sha256 as string);
    const content = {
      id: r.id,
      orgId: r.org_id,
      voucherNo: r.voucher_no,
      voucherDate: fixture.voucherDate,
      payeeName: r.payee_name,
      supplierId: r.supplier_id,
      amount: r.amount,
      currency: r.currency,
      category: r.category,
      special: r.special_category as SpecialCategory,
      branchCode: r.branch_code,
      costCentre: r.cost_centre,
      payFrom: r.pay_from,
      paymentMethod: r.payment_method,
      narration: r.narration,
      invoices: [{ id: inv, total: 105 }],
      documentHashes: docs,
    };
    expect(r.canon).toBe(voucherCanonical(content));
    expect(r.hash).toBe(voucherContentHash(content));
    // the invoice is now on the voucher
    expect(
      (await svc(() => q("select status from public.fin_supplier_invoices where id = $1", [inv])))
        .rows[0].status,
    ).toBe("on_voucher");
  });

  describe("the approval state machine gives the fixture's outcome at every step (parity with lib/finance/vouchers.ts)", () => {
    let locked = false;
    const lockJanuary = async () => {
      if (locked) return;
      await svc(async () => {
        const id = (
          await q(
            "select public.fin_close_store_snapshot($1, '2026-01-01', $2, '{}'::jsonb) as id",
            [orgA, users.fm],
          )
        ).rows[0].id as string;
        const h = (
          await q("select snapshot_hash from public.fin_period_closes where id = $1", [id])
        ).rows[0].snapshot_hash;
        await q("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          id,
          users.fm,
          h,
        ]);
        await q("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [orgA, id, users.ceo, h]);
      });
      locked = true;
    };

    it.each(fixture.scenarios.map((s) => [s.name, s] as const))("%s", async (_n, s) => {
      const sc = s as typeof s & {
        creator?: string;
        special?: string;
        documents?: number;
        inactiveTiers?: string[];
        locked?: boolean;
        approvalMode?: string;
      };
      const creator = users[sc.creator ?? "maker"];
      const docs = (sc.documents ?? 1) > 0 ? [await doc(orgA)] : [];
      const base = fields({
        amount: sc.amount,
        special_category: sc.special ?? "none",
        voucher_date: sc.locked ? fixture.lockedDate : fixture.voucherDate,
      });
      const v = await save(orgA, creator, null, base, docs);
      if (sc.locked) await lockJanuary();
      await svc(async () => {
        if (sc.inactiveTiers)
          await q(
            "update public.fin_ref_approval_tiers set active = false where org_id = $1 and code = any($2)",
            [orgA, sc.inactiveTiers],
          );
        if (sc.approvalMode)
          await q(
            "update public.fin_ref_finance_settings set approval_mode = $2 where org_id = $1",
            [orgA, sc.approvalMode],
          );
      });
      const got: string[] = [];
      let edits = 0;
      try {
        for (const step of s.steps as Array<{
          actor: string;
          action: string;
          hash?: string;
          remarks?: string;
          payment?: unknown;
          expect: string;
        }>) {
          if (step.action === "edit")
            got.push(
              await outcome(
                () =>
                  save(
                    orgA,
                    users[step.actor],
                    v.id,
                    { ...base, narration: `Synthetic voucher, edit ${++edits}` },
                    docs,
                  ),
                (r) => r.status ?? "?",
              ),
            );
          else
            got.push(
              await outcome(
                () =>
                  act(orgA, v.id, users[step.actor], step.action, {
                    hash: step.hash === "stale" ? STALE : undefined,
                    remarks: step.remarks,
                    payment: step.payment,
                  }),
                (r) => r.to ?? "?",
              ),
            );
        }
      } finally {
        await svc(async () => {
          await q("update public.fin_ref_approval_tiers set active = true where org_id = $1", [
            orgA,
          ]);
          await q(
            "update public.fin_ref_finance_settings set approval_mode = 'pulse' where org_id = $1",
            [orgA],
          );
        });
      }
      expect(got).toEqual(s.steps.map((x) => x.expect));
    });
  });

  it("keeps an append-only trail with who, what, remarks and the hash each step was bound to", async () => {
    const d = await doc(orgA);
    const v = await save(orgA, users.maker, null, fields({ amount: 20000 }), [d]);
    await act(orgA, v.id, users.maker, "submit");
    await act(orgA, v.id, users.fm, "check", { remarks: "Quotation attached" });
    await act(orgA, v.id, users.ceo, "reject", { remarks: "Second quotation needed" });
    const { rows } = await svc(() =>
      q(
        "select action, actor_id, remarks, content_sha256, from_status, to_status from public.fin_voucher_events where voucher_id = $1 order by id",
        [v.id],
      ),
    );
    expect(rows.map((r) => [r.action, r.actor_id, r.from_status, r.to_status])).toEqual([
      ["created", users.maker, null, "draft"],
      ["submitted", users.maker, "draft", "submitted"],
      ["checked", users.fm, "submitted", "checked"],
      ["rejected", users.ceo, "checked", "rejected"],
    ]);
    expect(rows[2].remarks).toBe("Quotation attached");
    expect(rows[3].remarks).toBe("Second quotation needed");
    expect(rows[1].content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[2].content_sha256).toBe(rows[1].content_sha256);
    // the rejection cleared the approvals but kept the remarks
    const vr = (
      await svc(() =>
        q("select checked_by, rejection_remarks from public.fin_payment_vouchers where id = $1", [
          v.id,
        ]),
      )
    ).rows[0];
    expect(vr).toEqual({ checked_by: null, rejection_remarks: "Second quotation needed" });
    for (const sql of [
      "update public.fin_voucher_events set remarks = 'tampered' where voucher_id = $1",
      "delete from public.fin_voucher_events where voucher_id = $1",
      "delete from public.fin_payment_vouchers where id = $1",
    ]) {
      const err = await svc(() => failure(sql, [v.id]));
      expect(code(err), sql).toBe("42501");
    }
  });

  it("refuses attachment changes once submitted, and rejects a voucher changed behind the approver's back", async () => {
    const d = await doc(orgA);
    const v = await save(orgA, users.maker, null, fields({ amount: 300 }), [d]);
    await act(orgA, v.id, users.maker, "submit");
    const extra = await doc(orgA);
    const err = await svc(() =>
      failure(
        "insert into public.fin_voucher_documents (org_id, voucher_id, document_id) values ($1, $2, $3)",
        [orgA, v.id, extra],
      ),
    );
    expect(hint(err)).toBe("wrong_status");
    // even the service role cannot change the content without returning the voucher to draft
    const err2 = await svc(() =>
      failure("update public.fin_payment_vouchers set amount = 299 where id = $1", [v.id]),
    );
    expect(hint(err2)).toBe("wrong_status");
  });

  it("bulk-verifies Tier 1 only, each voucher on its own hash", async () => {
    const mk = async (amount: number, special = "none") => {
      const v = await save(orgA, users.maker, null, fields({ amount, special_category: special }), [
        await doc(orgA),
      ]);
      await act(orgA, v.id, users.maker, "submit");
      const h = (
        await svc(() =>
          q("select content_sha256 from public.fin_payment_vouchers where id = $1", [v.id]),
        )
      ).rows[0].content_sha256 as string;
      return { id: v.id, hash: h };
    };
    const t1a = await mk(120);
    const t1b = await mk(4999.99);
    const t1stale = await mk(80);
    const t2 = await mk(6000);
    const payroll = await mk(50, "payroll");
    const items = [t1a, t1b, { id: t1stale.id, hash: STALE }, t2, payroll];
    const run = (user: string) =>
      svc(
        async () =>
          (
            await q("select public.fin_voucher_bulk_check($1, $2, $3::jsonb, null) as r", [
              orgA,
              user,
              JSON.stringify(items),
            ])
          ).rows[0].r,
      );
    const byMaker = await run(users.maker);
    expect(byMaker.done).toEqual([]); // the maker holds no check permission
    const r = await run(users.fm);
    expect(r.done.sort()).toEqual([t1a.id, t1b.id].sort());
    expect(
      Object.fromEntries(r.failed.map((f: { id: string; code: string }) => [f.id, f.code])),
    ).toEqual({
      [t1stale.id]: "hash_mismatch",
      [t2.id]: "bulk_not_allowed",
      [payroll.id]: "bulk_not_allowed",
    });
    const st = await svc(() =>
      q("select id, status from public.fin_payment_vouchers where id = any($1::uuid[])", [
        items.map((i) => i.id),
      ]),
    );
    const status = Object.fromEntries(st.rows.map((x) => [x.id, x.status]));
    expect([status[t1a.id], status[t1b.id], status[t1stale.id], status[t2.id]]).toEqual([
      "approved",
      "approved",
      "submitted",
      "submitted",
    ]);
  });

  it("records a Tally export atomically: items are marked once, and an exported voucher or invoice no longer changes", async () => {
    const supplier = (
      await svc(() =>
        q(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Supplier Test 10') returning id",
          [orgA],
        ),
      )
    ).rows[0].id as string;
    const inv = (
      await svc(() =>
        q(
          "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat) values ($1, $2, 'INV-T-10', '2026-10-03', 'Consumables', 200, 10) returning id",
          [orgA, supplier],
        ),
      )
    ).rows[0].id as string;
    const v = await save(orgA, users.maker, null, fields({ amount: 210 }), [await doc(orgA)]);
    await act(orgA, v.id, users.maker, "submit");
    await act(orgA, v.id, users.fm, "check");
    const record = (ids: string[], invs: string[]) =>
      svc(async () => {
        try {
          const r = await q(
            "select public.fin_tally_record_export($1, $2, $3::uuid[], $4::uuid[], $5, '<ENVELOPE/>', 420) as id",
            [orgA, users.maker, ids, invs, "c".repeat(64)],
          );
          return r.rows[0].id as string;
        } catch (e) {
          return `error:${hint(e)}`;
        }
      });
    const draft = await save(orgA, users.maker, null, fields({ amount: 10 }));
    expect(await record([v.id, draft.id], [inv])).toBe("error:stale_export"); // a draft is not exportable: nothing recorded
    expect(await record([v.id], [inv])).toMatch(/^[0-9a-f-]{36}$/);
    expect(await record([v.id], [])).toBe("error:stale_export"); // already exported
    expect(await record([], [inv])).toBe("error:stale_export");
    const err = await svc(() =>
      failure("update public.fin_supplier_invoices set net = 1 where id = $1", [inv]),
    );
    expect(hint(err)).toBe("wrong_status");
    expect(
      await outcome(
        () => save(orgA, users.maker, v.id, fields({ amount: 210, narration: "changed" })),
        (r) => r.status ?? "?",
      ),
    ).toBe("wrong_status");
    // the exported voucher can still be paid (the bank reference completes the trail), by someone other than its maker
    expect(
      (
        await act(orgA, v.id, users.fm, "pay", {
          payment: { date: "2026-10-10", reference: "BANKREF-0010" },
        })
      ).to,
    ).toBe("paid");
  });

  it("refuses supplier invoices dated in a locked month, for every role", async () => {
    const supplier = (
      await svc(() =>
        q(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Supplier Test 11') returning id",
          [orgA],
        ),
      )
    ).rows[0].id as string;
    // January 2026 is locked by the state-machine scenarios above
    const err = await svc(() =>
      failure(
        "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net) values ($1, $2, 'INV-T-11', '2026-01-20', 'Consumables', 10)",
        [orgA, supplier],
      ),
    );
    expect(code(err)).toBe("42501");
  });

  it("holds each file once per organisation (two organisations may hold the same file)", async () => {
    const ins = (org: string) =>
      svc(async () => {
        const e = await failure(
          "insert into public.fin_documents (org_id, kind, storage_path, mime_type, size_bytes, sha256, status) values ($1::uuid, 'other', $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 5, $2, 'ready')",
          [org, "e".repeat(64)],
        );
        return code(e) ?? "ok";
      });
    expect(await ins(orgA)).toBe("ok");
    expect(await ins(orgB)).toBe("ok");
    expect(await ins(orgA)).toBe("23505");
  });

  it("lets finance and approvers read payables, hides them from everyone else and from other organisations, and lets nobody write directly", async () => {
    const tables = [
      "fin_payment_vouchers",
      "fin_voucher_events",
      "fin_voucher_documents",
      "fin_suppliers",
      "fin_supplier_invoices",
      "fin_documents",
      "fin_ref_approval_tiers",
    ];
    const seen = async (u: string, t: string) =>
      as(u, async () =>
        Number(
          (await q(`select count(*)::int as n from public.${t} where org_id = $1`, [orgA])).rows[0]
            .n,
        ),
      );
    for (const u of ["maker", "fm", "ceo"])
      for (const t of tables) expect(await seen(u, t), `${u} ${t}`).toBeGreaterThan(0);
    // a department head reads only the Tier 2 vouchers waiting for one or that they decided (the fixture's Tier 2
    // scenarios), their trail and documents, and the tiers; not suppliers, other invoices or other vouchers
    // (tests/db/finance-payables-fixes.test.ts covers the rule in detail)
    for (const t of [
      "fin_payment_vouchers",
      "fin_voucher_events",
      "fin_voucher_documents",
      "fin_documents",
      "fin_ref_approval_tiers",
    ])
      expect(await seen("dept", t), `dept ${t}`).toBeGreaterThan(0);
    expect(await seen("dept", "fin_suppliers")).toBe(0);
    expect(await seen("dept", "fin_payment_vouchers")).toBeLessThan(
      await seen("fm", "fin_payment_vouchers"),
    );
    for (const u of ["billing", "md", "cost", "bob"])
      for (const t of tables) expect(await seen(u, t), `${u} ${t}`).toBe(0);
    // Tally exports: only the exporter
    expect(await seen("maker", "fin_tally_exports")).toBeGreaterThan(0);
    expect(await seen("ceo", "fin_tally_exports")).toBe(0);
    expect(await seen("dept", "fin_tally_exports")).toBe(0);
    for (const t of [
      ...tables,
      "fin_tally_exports",
      "fin_ref_tally_ledgers",
      "fin_voucher_invoices",
    ]) {
      const err = await as("fm", () =>
        failure(`insert into public.${t} (org_id) values ($1)`, [orgA]),
      );
      expect(code(err), t).toBe("42501");
    }
    // the counter is service-only
    expect(
      await as("admin", async () =>
        Number((await q("select count(*)::int as n from public.fin_voucher_counters")).rows[0].n),
      ),
    ).toBe(0);
  });

  it("logs a finance document open in the access log", async () => {
    await svc(() =>
      q(
        "insert into public.record_access_log (org_id, user_id, entity, entity_id, action) values ($1, $2, 'finance_document', gen_random_uuid()::text, 'view')",
        [orgA, users.maker],
      ),
    );
  });

  it("migration: grants the new keys to the existing presets and adds the Finance Manager and Department head roles exactly as the code presets", async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261024000100_finance_payables.sql"),
      "utf8",
    );
    const grant = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    const roleInserts =
      sql.match(/insert into public\.roles[\s\S]*?on conflict \(org_id, name\) do nothing;/g) ?? [];
    expect(grant).toBeTruthy();
    expect(roleInserts).toHaveLength(2);
    const orgC = await svc(async () => {
      const id = (
        await q("insert into public.orgs (name, slug) values ('Org C', 'org-c-20d') returning id")
      ).rows[0].id as string;
      const before = (name: string) =>
        FINANCE_ROLES.find((r) => r.name === name)!.permissions.filter(
          (p) =>
            !/^finance\.(payables|vouchers|tally|matching)\./.test(p) &&
            !p.startsWith("accounting."),
        );
      for (const name of ["Finance", "CEO"])
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
          [id, name, JSON.stringify(before(name))],
        );
      return id;
    });
    // Later Phase 20 keys reach an existing workspace's Finance Manager through the sync migration, so run it too: the
    // result must be exactly the code presets.
    const sync = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261102000100_finance_manager_sync.sql"),
      "utf8",
    );
    const run = () =>
      svc(async () => {
        await q(grant!);
        for (const s of roleInserts) await q(s);
        await q(sync);
      });
    await run();
    await run(); // idempotent
    const roles = Object.fromEntries(
      (
        await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
      ).rows.map((r) => [r.name, [...(r.permissions as string[])].sort()]),
    );
    // keys a later migration grants to the Finance Manager directly are tested with that slice (20F: revenue-share verify)
    // (22A: the accounting keys, tested in accounting-core.test.ts)
    // (W4: finance.parallel_run.manage, tested in finance-parallel-run.test.ts)
    // (docs/51: finance.group_pack.export, tested in finance-group-pack.test.ts)
    // (46: finance.matching.*, tested in finance-matching-v2.test.ts)
    const grantedLater = (p: string) =>
      p === "finance.revshare.verify" ||
      p === "finance.parallel_run.manage" ||
      p === "finance.group_pack.export" ||
      p.startsWith("accounting.") ||
      p.startsWith("finance.matching.");
    for (const name of ["Finance", "Finance Manager", "CEO", "Department head"])
      expect(roles[name], name).toEqual(
        FINANCE_ROLES.find((r) => r.name === name)!
          .permissions.filter((p) => !grantedLater(p))
          .sort(),
      );
    // separation of duties in the presets
    const perms = (n: string) => FINANCE_ROLES.find((r) => r.name === n)!.permissions;
    expect(perms("Finance")).not.toContain("finance.vouchers.check");
    expect(perms("Finance")).not.toContain("finance.vouchers.settings");
    expect(perms("Finance Manager")).toContain("finance.vouchers.check");
    expect(perms("CEO")).toEqual(expect.arrayContaining(["finance.vouchers.approve_ceo"]));
    expect(perms("CEO")).not.toContain("finance.vouchers.prepare");
    for (const n of ["Billing", "Insurance", "Medical Director", "Cost / Payroll"])
      expect(
        perms(n).some((p) => /^finance\.(payables|vouchers|tally)\./.test(p)),
        n,
      ).toBe(false);
  });
});
