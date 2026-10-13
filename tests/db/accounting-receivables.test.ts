/**
 * Phase 22E: receivables, database side. Seeding (the customer receivable ledger, rental income, settings; new orgs),
 * customers (payer link, receivable ledger), sales documents (totals re-checked against lib/accounting/sales.ts, the sales
 * tax codes and income ledgers), issue (gap-free numbers per fiscal year that a refused issue gives back, a balanced
 * journal, full or simplified, due date), the approval limit (a different person with the approval permission, bound to
 * the content hash), void (a credit note in full that reverses the journal), credit notes, receipts and allocations
 * (oldest first, by hand, part paid and paid, on account, void), the before_ledger_start path (simulated by a trigger, then
 * retried), immutability, open items and statements, and who reads what. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { invoiceTotals } from "@/lib/accounting/sales";
import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type DocLine = {
  description?: string;
  quantity: number;
  unit_price: number;
  discount?: number;
  income?: string;
  tax?: "VAT5" | "ZR";
  branch_code?: string;
};

describe.skipIf(!TEST_DATABASE_URL)("Accounting receivables (Phase 22E)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const as = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const code = (e: unknown) => (e as { code?: string } | null)?.code ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const idOf = async (table: string, col: string, val: string, org = orgA) =>
    (
      await one<{ id: string }>(
        `select id from public.${table} where org_id = $1 and ${col} = $2`,
        [org, val],
      )
    ).id;

  /** Save a draft through acc_sales_doc_save, with expected_total from the TypeScript rules. */
  const save = async (
    maker: string,
    customer: string,
    lines: DocLine[],
    header: Record<string, unknown> = {},
    id: string | null = null,
    expectedOverride?: number,
  ) => {
    const rate = (t?: string) => (t === "ZR" ? 0 : 5);
    const expected =
      expectedOverride ??
      invoiceTotals(
        lines.map((l) => ({
          quantity: l.quantity,
          unitPrice: l.unit_price,
          discount: l.discount ?? 0,
          vatRate: rate(l.tax),
        })),
      ).total;
    const payload = [];
    for (const l of lines)
      payload.push({
        description: l.description ?? "Synthetic service",
        quantity: l.quantity,
        unit_price: l.unit_price,
        discount: l.discount ?? 0,
        income_account_id: await idOf("acc_accounts", "code", l.income ?? "4190"),
        tax_code_id: await idOf("acc_tax_codes", "code", l.tax ?? "VAT5"),
        branch_code: l.branch_code ?? "",
      });
    return one<{ r: { id: string; sha256: string; total: string } }>(
      "select public.acc_sales_doc_save($1, $2, $3, $4::jsonb, $5::jsonb) as r",
      [
        orgA,
        users[maker],
        id,
        JSON.stringify({
          kind: "invoice",
          customer_id: customer,
          invoice_date: "2026-07-10",
          expected_total: expected,
          ...header,
        }),
        JSON.stringify(payload),
      ],
    ).then((x) => x.r);
  };
  const issue = (id: string, user: string, hash: string | null = null) =>
    one<{
      r: {
        number: string;
        status: string;
        posting_status: string;
        journal_id: string | null;
        invoice_form: string;
      };
    }>("select public.acc_sales_doc_issue($1, $2, $3, $4) as r", [
      orgA,
      id,
      users[user],
      hash,
    ]).then((x) => x.r);
  const doc = (id: string) =>
    one<{
      status: string;
      number: string;
      total: string;
      amount_paid: string;
      amount_credited: string;
      due_date: string;
      invoice_form: string;
      posting_status: string;
      journal_id: string | null;
      approved_by: string | null;
      void_credit_note_id: string | null;
    }>(
      "select status, number, total::text, amount_paid::text, amount_credited::text, to_char(due_date, 'YYYY-MM-DD') as due_date, invoice_form, posting_status, journal_id, approved_by, void_credit_note_id from public.acc_sales_invoices where id = $1",
      [id],
    );
  const journalLines = async (journalId: string) =>
    (
      await svc(() =>
        q(
          `select a.code, l.debit::float as debit, l.credit::float as credit, l.party_kind, l.party_id, l.payer_id
           from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id
           where l.journal_id = $1 order by l.line_no`,
          [journalId],
        ),
      )
    ).rows as Array<{
      code: string;
      debit: number;
      credit: number;
      party_kind: string | null;
      party_id: string | null;
      payer_id: string | null;
    }>;
  const issued = async (
    customer: string,
    lines: DocLine[],
    header: Record<string, unknown> = {},
  ) => {
    const d = await save("acct", customer, lines, header);
    await issue(d.id, "acct");
    return d.id;
  };
  const receipt = (
    customer: string,
    amount: number,
    allocations: Array<{ invoice_id: string; amount: number }> | null,
    date = "2026-08-01",
  ) =>
    one<{ r: { id: string; number: string; allocated: string; posting_status: string } }>(
      "select public.acc_receipt_save($1, $2, $3::jsonb, $4::jsonb) as r",
      [
        orgA,
        users.acct,
        JSON.stringify({
          customer_id: customer,
          receipt_date: date,
          account_id: ids.bank,
          amount,
          mode: "bank_transfer",
          reference: "SYN-REF",
        }),
        allocations === null ? null : JSON.stringify(allocations),
      ],
    ).then((x) => x.r);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of [
      "alice",
      "bob",
      "acct",
      "acct2",
      "chief",
      "fm",
      "ceo",
      "auditor",
      "fin",
      "nobody",
    ])
      users[n] = await createAuthUser(c, `${n}-ar@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("acct", "Accountant");
      await member("acct2", "Accountant");
      await member("chief", "Chief Accountant");
      await member("fm", "Finance Manager");
      await member("ceo", "CEO");
      await member("auditor", "Auditor");
      await member("fin", "Finance");
      await q(
        "insert into public.fin_ref_payers (org_id, payer_id, payer_name) values ($1, 'PAYER-SYN', 'Payer Synthetic')",
        [orgA],
      );
      // once the ledger start rule exists (22D), start the ledger well before the synthetic dates
      const col = await q(
        "select 1 from information_schema.columns where table_schema = 'public' and table_name = 'acc_entities' and column_name = 'ledger_start_date'",
      );
      if (col.rowCount)
        await q(
          "update public.acc_entities set ledger_start_date = '2020-01-01' where org_id = $1",
          [orgA],
        );
      const cust = async (name: string, kind: string, extra: Record<string, unknown> = {}) =>
        (
          await q(
            `insert into public.acc_customers (org_id, kind, name, trn, payer_id, credit_terms_days)
             values ($1, $2, $3, $4, $5, $6) returning id::text as id`,
            [orgA, kind, name, extra.trn ?? null, extra.payer_id ?? null, extra.terms ?? 30],
          )
        ).rows[0].id as string;
      ids.corp = await cust("Synthetic Corporate LLC", "corporate", { trn: "100000000000003" });
      ids.tenant = await cust("Synthetic Tenant", "tenant", { terms: 0 });
      ids.insurer = await cust("Synthetic Insurer", "insurer", {
        payer_id: "PAYER-SYN",
        trn: "100000000000011",
      });
      ids.other = await cust("Synthetic Other", "other");
    });
    ids.bank = await idOf("acc_accounts", "code", "1150");
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("seeding and customers", () => {
    it("gives every org the customer receivable control ledger, rental income and a settings row", async () => {
      for (const org of [orgA, orgB]) {
        const { rows } = await svc(() =>
          q(
            "select code, name, control, nature from public.acc_accounts where org_id = $1 and code in ('1230', '4910') order by code",
            [org],
          ),
        );
        expect(rows).toEqual([
          // 22K: 1230 (1220 is 22D's corporate receivable)
          { code: "1230", name: "Customer receivables", control: "receivable", nature: "asset" },
          { code: "4910", name: "Rental income", control: null, nature: "income" },
        ]);
        const s = await one<{ t: string; l: string }>(
          "select issue_approval_threshold::text as t, simplified_invoice_limit::text as l from public.acc_ar_settings where org_id = $1",
          [org],
        );
        expect(s).toEqual({ t: "50000.00", l: "10000.00" });
      }
      const again = await one<{ n: number }>("select public.acc_seed_receivables($1) as n", [orgA]);
      expect(again.n).toBe(0);
    });

    it("links a payer only to an insurer, and only a receivables ledger as the receivable account", async () => {
      const e1 = await fails(
        svc(() =>
          q(
            "insert into public.acc_customers (org_id, kind, name, payer_id) values ($1, 'insurer', 'Bad payer', 'NOPE')",
            [orgA],
          ),
        ),
      );
      expect(hint(e1)).toBe("customer_payer");
      const e2 = await fails(
        svc(() =>
          q(
            "insert into public.acc_customers (org_id, kind, name, payer_id) values ($1, 'corporate', 'Corp payer', 'PAYER-SYN')",
            [orgA],
          ),
        ),
      );
      expect(code(e2)).toBe("23514");
      const e3 = await fails(
        svc(() =>
          q(
            "insert into public.acc_customers (org_id, kind, name, receivable_account_id) select $1, 'other', 'Bad ledger', id from public.acc_accounts where org_id = $1 and code = '1150'",
            [orgA],
          ),
        ),
      );
      expect(hint(e3)).toBe("receivable_account");
    });
  });

  describe("sales invoices", () => {
    it("re-checks the totals, the sales tax code and the income ledger", async () => {
      const lines: DocLine[] = [
        { quantity: 1, unit_price: 0.1 },
        { quantity: 1, unit_price: 0.1 },
        { quantity: 1, unit_price: 0.1 },
        { quantity: 1, unit_price: 1000, discount: 100, tax: "ZR" },
      ];
      const ok = await save("acct", ids.corp, lines);
      expect(Number(ok.total)).toBe(900.33); // VAT 3 x 0.01 per line
      expect(hint(await fails(save("acct", ids.corp, lines, {}, null, 900.32)))).toBe(
        "totals_mismatch",
      );
      const rc = await idOf("acc_tax_codes", "code", "RC5");
      const e = await fails(
        one("select public.acc_sales_doc_save($1, $2, null, $3::jsonb, $4::jsonb)", [
          orgA,
          users.acct,
          JSON.stringify({
            customer_id: ids.corp,
            invoice_date: "2026-07-10",
            expected_total: 105,
          }),
          JSON.stringify([
            {
              description: "x",
              quantity: 1,
              unit_price: 100,
              income_account_id: await idOf("acc_accounts", "code", "4190"),
              tax_code_id: rc,
            },
          ]),
        ]),
      );
      expect(hint(e)).toBe("sales_tax_code");
      expect(
        hint(await fails(save("acct", ids.corp, [{ quantity: 1, unit_price: 5, income: "6200" }]))),
      ).toBe("income_account");
      expect(hint(await fails(save("fin", ids.corp, lines)))).toBe("not_permitted");
      await one("select public.acc_sales_doc_discard($1, $2, $3)", [orgA, ok.id, users.acct]);
    });

    it("issues with a gap-free number per fiscal year and posts a balanced journal against the customer", async () => {
      const d = await save("acct", ids.corp, [
        { quantity: 2, unit_price: 500, branch_code: "P" },
        { quantity: 1, unit_price: 300, tax: "ZR", income: "4100" },
      ]);
      const r = await issue(d.id, "acct");
      expect(r).toMatchObject({
        number: "SI/2026-27/00001",
        status: "issued",
        posting_status: "posted",
        invoice_form: "full",
      });
      const row = await doc(d.id);
      expect(row.due_date).toBe("2026-08-09"); // 30 days' terms
      expect(Number(row.total)).toBe(1350);
      const jl = await journalLines(r.journal_id!);
      expect(jl.map((l) => [l.code, l.debit, l.credit])).toEqual([
        ["1230", 1350, 0],
        ["4190", 0, 1000],
        ["4100", 0, 300],
        ["2200", 0, 50],
      ]);
      expect(jl[0]).toMatchObject({ party_kind: "customer", party_id: ids.corp });
      const j = await one<{ voucher_type: string; source_kind: string; number: string }>(
        "select voucher_type, source_kind, number from public.acc_journals where id = $1",
        [r.journal_id],
      );
      expect(j).toMatchObject({ voucher_type: "sales", source_kind: "sales_invoice" });
      expect(j.number).toMatch(/^SAL\/2026-27\//);
    });

    it("gives the number back when an issue is refused, and starts a new series in a new fiscal year", async () => {
      const d = await save("acct", ids.tenant, [{ quantity: 1, unit_price: 100, income: "4910" }]);
      await svc(() =>
        q("update public.acc_accounts set is_active = false where org_id = $1 and code = '4910'", [
          orgA,
        ]),
      );
      expect(hint(await fails(issue(d.id, "acct")))).toBe("account_inactive");
      await svc(() =>
        q("update public.acc_accounts set is_active = true where org_id = $1 and code = '4910'", [
          orgA,
        ]),
      );
      expect((await issue(d.id, "acct")).number).toBe("SI/2026-27/00002");
      // 30 June belongs to the previous fiscal year (July to June)
      const old = await save(
        "acct",
        ids.tenant,
        [{ quantity: 1, unit_price: 100, income: "4910" }],
        {
          invoice_date: "2026-06-30",
        },
      );
      expect((await issue(old.id, "acct")).number).toBe("SI/2025-26/00001");
      const t = await doc(d.id);
      expect(t.due_date).toBe("2026-07-10"); // no credit terms
      expect(t.invoice_form).toBe("simplified"); // no TRN, under AED 10,000
    });

    it("is full above AED 10,000 even without a TRN", async () => {
      const id = await issued(ids.other, [{ quantity: 1, unit_price: 9600 }]);
      expect((await doc(id)).invoice_form).toBe("full"); // 9,600 + 480 VAT = 10,080
    });

    it("above the approval limit needs a different person with the approval permission and the reviewed hash", async () => {
      await svc(() =>
        q("update public.acc_ar_settings set issue_approval_threshold = 1000 where org_id = $1", [
          orgA,
        ]),
      );
      try {
        const d = await save("acct", ids.corp, [{ quantity: 1, unit_price: 2000 }]);
        expect(hint(await fails(issue(d.id, "acct", d.sha256)))).toBe("approval_required");
        expect(hint(await fails(issue(d.id, "acct2", d.sha256)))).toBe("approval_required");
        expect(hint(await fails(issue(d.id, "fm", "0".repeat(64))))).toBe("hash_mismatch");
        expect(hint(await fails(issue(d.id, "fm", null)))).toBe("hash_mismatch");
        const r = await issue(d.id, "fm", d.sha256);
        expect(r.status).toBe("issued");
        expect((await doc(d.id)).approved_by).toBe(users.fm);
        // the table repeats the rule
        const e = await fails(
          svc(() =>
            q(
              "insert into public.acc_sales_invoices (org_id, entity_id, customer_id, invoice_date, approval_required, prepared_by, approved_by) select org_id, id, $2, '2026-07-01', true, $3, $3 from public.acc_entities where org_id = $1",
              [orgA, ids.corp, users.acct],
            ),
          ),
        );
        expect(code(e)).toBe("23514");
      } finally {
        await svc(() =>
          q(
            "update public.acc_ar_settings set issue_approval_threshold = 50000 where org_id = $1",
            [orgA],
          ),
        );
      }
    });

    it("keeps an issued document as it is: no edit, no delete, no line change", async () => {
      const id = await issued(ids.corp, [{ quantity: 1, unit_price: 10 }]);
      expect(
        hint(
          await fails(
            svc(() => q("update public.acc_sales_invoices set total = 1 where id = $1", [id])),
          ),
        ),
      ).toBe("posted_immutable");
      expect(
        hint(
          await fails(svc(() => q("delete from public.acc_sales_invoices where id = $1", [id]))),
        ),
      ).toBe("posted_immutable");
      expect(
        hint(
          await fails(
            svc(() =>
              q(
                "update public.acc_sales_invoice_lines set description = 'x' where invoice_id = $1",
                [id],
              ),
            ),
          ),
        ),
      ).toBe("posted_immutable");
      expect(
        hint(await fails(save("acct", ids.corp, [{ quantity: 1, unit_price: 10 }], {}, id))),
      ).toBe("wrong_status");
    });

    it("voids with a credit note in full that reverses income, VAT and the receivable", async () => {
      const id = await issued(ids.insurer, [{ quantity: 4, unit_price: 250, branch_code: "G" }]);
      const inv = await doc(id);
      const jl = await journalLines(inv.journal_id!);
      expect(jl[0]).toMatchObject({ code: "1230", debit: 1050, payer_id: "PAYER-SYN" });
      const v = await one<{ r: { credit_note_id: string; credit_note_number: string } }>(
        "select public.acc_sales_invoice_void($1, $2, $3, '2026-07-20', 'Synthetic void') as r",
        [orgA, id, users.acct],
      ).then((x) => x.r);
      expect(v.credit_note_number).toBe("CN/2026-27/00001");
      const after = await doc(id);
      expect(after).toMatchObject({ status: "void", void_credit_note_id: v.credit_note_id });
      const cn = await doc(v.credit_note_id);
      const cl = await journalLines(cn.journal_id!);
      expect(cl.map((l) => [l.code, l.debit, l.credit])).toEqual(
        jl.map((l) => [l.code, l.credit, l.debit]),
      );
      const cj = await one<{ voucher_type: string }>(
        "select voucher_type from public.acc_journals where id = $1",
        [cn.journal_id],
      );
      expect(cj.voucher_type).toBe("credit_note");
      expect(
        hint(
          await fails(
            one("select public.acc_sales_invoice_void($1, $2, $3, '2026-07-20', 'again')", [
              orgA,
              id,
              users.acct,
            ]),
          ),
        ),
      ).toBe("wrong_status");
    });

    it("credits part of an invoice, refuses more than is left, and voids it when fully credited", async () => {
      const id = await issued(ids.corp, [{ quantity: 1, unit_price: 1000 }]); // 1,050
      const cn1 = await save("acct", ids.corp, [{ quantity: 1, unit_price: 400 }], {
        kind: "credit_note",
        original_invoice_id: id,
        invoice_date: "2026-07-15",
        event_date: "2026-07-14",
        credit_reason: "Synthetic price change",
      });
      expect((await issue(cn1.id, "acct")).number).toMatch(/^CN\/2026-27\//);
      expect(await doc(id)).toMatchObject({ status: "issued", amount_credited: "420.00" });
      const big = await save("acct", ids.corp, [{ quantity: 1, unit_price: 700 }], {
        kind: "credit_note",
        original_invoice_id: id,
        invoice_date: "2026-07-16",
      });
      expect(hint(await fails(issue(big.id, "acct")))).toBe("credit_exceeds");
      const rest = await save(
        "acct",
        ids.corp,
        [{ quantity: 1, unit_price: 600 }],
        { kind: "credit_note", original_invoice_id: id, invoice_date: "2026-07-16" },
        big.id,
      );
      await issue(rest.id, "acct");
      expect(await doc(id)).toMatchObject({ status: "void", amount_credited: "1050.00" });
      // a credit note for another customer's invoice is refused
      const other = await fails(
        save("acct", ids.tenant, [{ quantity: 1, unit_price: 1 }], {
          kind: "credit_note",
          original_invoice_id: id,
        }),
      );
      expect(hint(other)).toBe("original_invoice");
    });
  });

  describe("receipts and allocations", () => {
    let i1: string;
    let i2: string;
    let i3: string;
    beforeAll(async () => {
      i2 = await issued(ids.tenant, [{ quantity: 1, unit_price: 200, income: "4910" }], {
        invoice_date: "2026-08-05",
      }); // 210
      i1 = await issued(ids.tenant, [{ quantity: 1, unit_price: 100, income: "4910" }], {
        invoice_date: "2026-08-01",
      }); // 105
      i3 = await issued(ids.tenant, [{ quantity: 1, unit_price: 1000, income: "4910" }], {
        invoice_date: "2026-08-10",
      }); // 1,050
    });

    it("allocates oldest first, posts Dr bank Cr receivable, and marks part paid and paid", async () => {
      // the tenant also has the July invoices from earlier tests (105 each, one dated 30 June)
      const open = await one<{ r: { invoices: Array<{ id: string; open: string }> } }>(
        "select public.acc_ar_open_items($1, $2, '2026-12-31') as r",
        [orgA, ids.tenant],
      ).then((x) => x.r.invoices);
      const before = open
        .filter((o) => ![i1, i2, i3].includes(o.id))
        .reduce((s, o) => s + Number(o.open), 0);
      const r = await receipt(ids.tenant, before + 105 + 100, null, "2026-08-20");
      expect(r.number).toBe("RV/2026-27/00001");
      expect(Number(r.allocated)).toBe(before + 205);
      expect(await doc(i1)).toMatchObject({ status: "paid", amount_paid: "105.00" });
      expect(await doc(i2)).toMatchObject({ status: "part_paid", amount_paid: "100.00" });
      expect((await doc(i3)).status).toBe("issued");
      const j = await one<{ journal_id: string }>(
        "select journal_id from public.acc_receipts where id = $1",
        [r.id],
      );
      const jl = await journalLines(j.journal_id);
      expect(jl.map((l) => [l.code, l.debit, l.credit])).toEqual([
        ["1150", before + 205, 0],
        ["1230", 0, before + 205],
      ]);
    });

    it("takes allocations by hand, leaves the rest on account, and refuses too much", async () => {
      expect(
        hint(await fails(receipt(ids.tenant, 100, [{ invoice_id: i2, amount: 110.01 }]))),
      ).toBe("allocation_exceeds");
      expect(hint(await fails(receipt(ids.tenant, 50, [{ invoice_id: i3, amount: 60 }])))).toBe(
        "over_allocated",
      );
      expect(
        hint(
          await fails(
            receipt(ids.tenant, 50, [
              {
                invoice_id: (await save("acct", ids.corp, [{ quantity: 1, unit_price: 1 }])).id,
                amount: 1,
              },
            ]),
          ),
        ),
      ).toBe("allocation_customer");
      const r = await receipt(ids.tenant, 500, [{ invoice_id: i3, amount: 300 }]);
      expect(Number(r.allocated)).toBe(300);
      expect(await doc(i3)).toMatchObject({ status: "part_paid", amount_paid: "300.00" });
      const items = await one<{ r: { on_account: Array<{ id: string; unallocated: string }> } }>(
        "select public.acc_ar_open_items($1, $2, '2026-12-31') as r",
        [orgA, ids.tenant],
      ).then((x) => x.r.on_account);
      expect(items.find((x) => x.id === r.id)?.unallocated).toBe(200);
      // re-allocate: the rest to i2 (110) and i3 (90)
      await one("select public.acc_receipt_allocate($1, $2, $3, $4::jsonb)", [
        orgA,
        r.id,
        users.acct,
        JSON.stringify([
          { invoice_id: i3, amount: 390 },
          { invoice_id: i2, amount: 110 },
        ]),
      ]);
      expect(await doc(i2)).toMatchObject({ status: "paid", amount_paid: "210.00" });
      expect(await doc(i3)).toMatchObject({ status: "part_paid", amount_paid: "390.00" });
      // an invoice with receipts cannot be voided
      expect(
        hint(
          await fails(
            one("select public.acc_sales_invoice_void($1, $2, $3, '2026-08-30', 'Synthetic')", [
              orgA,
              i3,
              users.acct,
            ]),
          ),
        ),
      ).toBe("has_receipts");
      ids.manualReceipt = r.id;
    });

    it("voids a receipt: the journal is reversed and the invoices are open again", async () => {
      const v = await one<{ r: { reversal_number: string } }>(
        "select public.acc_receipt_void($1, $2, $3, '2026-08-31', 'Synthetic bounce') as r",
        [orgA, ids.manualReceipt, users.acct],
      ).then((x) => x.r);
      expect(v.reversal_number).toMatch(/^RCT\//);
      expect(await doc(i2)).toMatchObject({ status: "part_paid", amount_paid: "100.00" });
      expect(await doc(i3)).toMatchObject({ status: "issued", amount_paid: "0.00" });
      const j = await one<{ status: string }>(
        "select j.status from public.acc_receipts r join public.acc_journals j on j.id = r.journal_id where r.id = $1",
        [ids.manualReceipt],
      );
      expect(j.status).toBe("reversed");
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_receipts set amount = 1 where id = $1", [ids.manualReceipt]),
            ),
          ),
        ),
      ).toBe("posted_immutable");
    });

    it("the statement and the open items agree with the ledger for the customer", async () => {
      const st = await one<{
        r: { opening: string; entries: Array<{ debit: string; credit: string }> };
      }>("select public.acc_ar_statement($1, $2, '2026-07-01', '2026-12-31') as r", [
        orgA,
        ids.tenant,
      ]).then((x) => x.r);
      const closing =
        Number(st.opening) + st.entries.reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0);
      const gl = await one<{ b: string }>(
        `select coalesce(sum(l.debit - l.credit), 0)::text as b
         from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id
         where l.org_id = $1 and a.code = '1230' and l.party_kind = 'customer' and l.party_id = $2`,
        [orgA, ids.tenant],
      );
      expect(Math.round(closing * 100) / 100).toBe(Number(gl.b));
      const open = await one<{
        r: { invoices: Array<{ open: string }>; on_account: Array<{ unallocated: string }> };
      }>("select public.acc_ar_open_items($1, $2, '2026-12-31') as r", [orgA, ids.tenant]).then(
        (x) => x.r,
      );
      const openSum =
        open.invoices.reduce((s, i) => s + Number(i.open), 0) -
        open.on_account.reduce((s, i) => s + Number(i.unallocated), 0);
      expect(Math.round(openSum * 100) / 100).toBe(Number(gl.b));
    });
  });

  describe("before the ledger start", () => {
    it("keeps the document issued, waiting for the ledger start, and posts it on retry", async () => {
      // as the database owner (the test connection): the service role cannot create triggers
      await q(`create or replace function public.test_before_ledger_start() returns trigger language plpgsql as $f$
           begin
             if new.source_kind in ('sales_invoice', 'receipt') and new.journal_date < date '2026-01-01' then
               raise exception 'before the ledger start' using errcode = 'check_violation', hint = 'before_ledger_start';
             end if;
             return new;
           end $f$`);
      await q(
        "create trigger test_before_ledger_start before insert on public.acc_journals for each row execute function public.test_before_ledger_start()",
      );
      let id = "";
      let rid = "";
      try {
        const d = await save("acct", ids.other, [{ quantity: 1, unit_price: 100 }], {
          invoice_date: "2025-12-15",
        });
        const r = await issue(d.id, "acct");
        expect(r).toMatchObject({
          status: "issued",
          posting_status: "waiting_ledger_start",
          journal_id: null,
        });
        expect(r.number).toBe("SI/2025-26/00002");
        id = d.id;
        const rc = await receipt(ids.other, 105, null, "2025-12-20");
        expect(rc.posting_status).toBe("waiting_ledger_start");
        expect(await doc(id)).toMatchObject({ status: "paid" });
        rid = rc.id;
        const still = await one<{ r: { posted: number; waiting: number } }>(
          "select public.acc_ar_retry_postings($1) as r",
          [orgA],
        );
        expect(still.r).toMatchObject({ posted: 0, waiting: 2 });
      } finally {
        await q("drop trigger test_before_ledger_start on public.acc_journals");
        await q("drop function public.test_before_ledger_start()");
      }
      const done = await one<{ r: { posted: number; waiting: number; failed: number } }>(
        "select public.acc_ar_retry_postings($1) as r",
        [orgA],
      );
      expect(done.r).toEqual({ posted: 2, waiting: 0, failed: 0 });
      expect((await doc(id)).posting_status).toBe("posted");
      const rr = await one<{ posting_status: string }>(
        "select posting_status from public.acc_receipts where id = $1",
        [rid],
      );
      expect(rr.posting_status).toBe("posted");
    });
  });

  describe("who reads what", () => {
    const seen = (user: string, table: string) =>
      as(user, async () =>
        Number(
          (await q(`select count(*)::int as n from public.${table} where org_id = $1`, [orgA]))
            .rows[0].n,
        ),
      );
    const TABLES = [
      "acc_customers",
      "acc_sales_invoices",
      "acc_sales_invoice_lines",
      "acc_receipts",
      "acc_allocations",
      "acc_ar_number_series",
      "acc_ar_settings",
    ];

    it("sales, receipts, ledger, reports and approve keys read; Finance, outsiders and other orgs do not", async () => {
      for (const u of ["acct", "chief", "fm", "auditor", "ceo", "alice"])
        for (const t of TABLES) expect(await seen(u, t), `${u} ${t}`).toBeGreaterThan(0);
      for (const u of ["fin", "nobody", "bob"])
        for (const t of TABLES) expect(await seen(u, t), `${u} ${t}`).toBe(0);
    });

    it("lets nobody write directly; the functions are service-role only", async () => {
      for (const sql of [
        "insert into public.acc_customers (org_id, kind, name) values ($1, 'other', 'Sneaky')",
        "update public.acc_sales_invoices set notes = 'x' where org_id = $1",
        "delete from public.acc_allocations where org_id = $1",
      ]) {
        const r = await as("alice", () =>
          q(sql, [orgA]).then(
            (x) => x.rowCount,
            (e: unknown) => code(e),
          ),
        );
        expect([0, "42501"], sql).toContain(r);
      }
      const e = await as("chief", () =>
        fails(q("select public.acc_ar_retry_postings($1)", [orgA])),
      );
      expect(code(e)).toBe("42501");
    });

    it("keeps history of invoices and receipts", async () => {
      const { rows } = await svc(() =>
        q(
          "select distinct table_name from public.record_history where org_id = $1 and table_name in ('acc_sales_invoices', 'acc_receipts') order by 1",
          [orgA],
        ),
      );
      expect(rows.map((r) => r.table_name)).toEqual(["acc_receipts", "acc_sales_invoices"]);
    });
  });
});
