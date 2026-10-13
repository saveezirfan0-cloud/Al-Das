/**
 * Phase 20B: the finance intake, database side. The migration's grant (Finance and Finance Manager, idempotent, equal to
 * the code presets), the new kinds and the sender-domain rule on fin_documents, the routing trigger (the first link to a
 * supplier invoice or a voucher takes a document out of the inbox and labels an unlabelled one; a link to a document that
 * is not ready, such as one being discarded, is refused), and who reads inbox documents (finance.inbox.manage, own org
 * only; nobody writes directly). Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Finance intake (Phase 20B)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  let seq = 1;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint;
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  const failure = (sql: string, params: unknown[] = []) =>
    q(sql, params).then(
      () => null,
      (x: unknown) => x,
    );

  /** A finance document (service role). Inbox documents carry inbox_at; e-mailed ones the sender domain. */
  const doc = (
    org: string,
    over: { kind?: string; inbox?: boolean; email?: boolean; status?: string } = {},
  ) =>
    svc(async () => {
      const n = seq++;
      const { rows } = await q(
        `insert into public.fin_documents (org_id, kind, source, storage_path, mime_type, size_bytes, sha256, status, inbox_at, sender_domain)
         values ($1::uuid, $2, $3, $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 1000,
                 case when $4 = 'ready' then lpad(to_hex($5::int), 64, '0') end, $4,
                 case when $6 then now() end, case when $3 = 'email' then 'supplier-one.example' end)
         returning id`,
        [
          org,
          over.kind ?? "unclassified",
          over.email ? "email" : "upload",
          over.status ?? "ready",
          n,
          over.inbox ?? true,
        ],
      );
      return rows[0].id as string;
    });
  const read = (id: string) =>
    svc(
      async () =>
        (await q("select kind, routed_at, status from public.fin_documents where id = $1", [id]))
          .rows[0],
    );
  let supplier: string;
  let invoiceSeq = 1;
  const invoice = (documentId: string | null) =>
    svc(async () => {
      const { rows } = await q(
        "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat, document_id) values ($1, $2, $3, '2026-11-01', 'Consumables', 100, 5, $4) returning id",
        [orgA, supplier, `INV-20B-${invoiceSeq++}`, documentId],
      );
      return rows[0].id as string;
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "fm", "inboxOnly", "payablesOnly", "ceo"])
      users[n] = await createAuthUser(c, `${n}-intake@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-20b", users.alice);
    orgB = await createOrg(c, "Org B", "org-b-20b", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      for (const [name, perms] of [
        ["Inbox only", ["finance.inbox.manage"]],
        ["Payables only", ["finance.payables.view"]],
      ] as const)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, false)",
          [orgA, name, JSON.stringify(perms)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fin", "Finance");
      await member("fm", "Finance Manager");
      await member("inboxOnly", "Inbox only");
      await member("payablesOnly", "Payables only");
      await member("ceo", "CEO");
      supplier = (
        await q(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Supplier Test 20B') returning id",
          [orgA],
        )
      ).rows[0].id as string;
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("migration: grants finance.inbox.manage to Finance and the Finance Manager once, matching the code presets", async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261103000100_finance_intake.sql"),
      "utf8",
    );
    const grant = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(grant).toBeTruthy();
    const orgC = await svc(async () => {
      const id = (
        await q("insert into public.orgs (name, slug) values ('Org C', 'org-c-20b') returning id")
      ).rows[0].id as string;
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
          [id, r.name, JSON.stringify(r.permissions.filter((p) => p !== "finance.inbox.manage"))],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Finance helper', '', '[\"finance.view\"]'::jsonb, false)",
        [id],
      );
      return id;
    });
    await svc(() => q(grant!));
    await svc(() => q(grant!)); // idempotent
    const roles = Object.fromEntries(
      (
        await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
      ).rows.map((r) => [r.name, [...(r.permissions as string[])].sort()]),
    );
    for (const r of FINANCE_ROLES) expect(roles[r.name], r.name).toEqual([...r.permissions].sort());
    expect(
      FINANCE_ROLES.filter((r) => r.permissions.includes("finance.inbox.manage"))
        .map((r) => r.name)
        .sort(),
    ).toEqual(["Finance", "Finance Manager"]);
    expect(roles["Finance helper"]).toEqual(["finance.view"]);
  });

  it("takes the new kinds and keeps the sender domain to e-mailed files, in lower case", async () => {
    await doc(orgA, { kind: "processor_report" });
    await doc(orgA, { kind: "unclassified", email: true });
    await svc(async () => {
      expect(
        code(
          await failure("update public.fin_documents set kind = 'mystery' where org_id = $1", [
            orgA,
          ]),
        ),
      ).toBe("23514");
      expect(
        code(
          await failure(
            "update public.fin_documents set sender_domain = 'supplier-one.example' where org_id = $1 and source = 'upload'",
            [orgA],
          ),
        ),
      ).toBe("23514");
      expect(
        code(
          await failure(
            "update public.fin_documents set sender_domain = 'Supplier-One.EXAMPLE' where org_id = $1 and source = 'email'",
            [orgA],
          ),
        ),
      ).toBe("23514");
    });
  });

  it("the first supplier invoice to link a document routes it and labels an unlabelled one; a label already given stays", async () => {
    const unlabelled = await doc(orgA);
    const statement = await doc(orgA, { kind: "bank_statement" });
    expect((await read(unlabelled)).routed_at).toBeNull();
    const inv = await invoice(unlabelled);
    const after = await read(unlabelled);
    expect(after.kind).toBe("supplier_invoice");
    expect(after.routed_at).not.toBeNull();
    await invoice(statement);
    expect(await read(statement)).toMatchObject({ kind: "bank_statement" });
    // editing the invoice without changing its document, or linking the same document again, changes nothing
    await svc(() =>
      q("update public.fin_supplier_invoices set category = 'Lab' where id = $1", [inv]),
    );
    expect((await read(unlabelled)).routed_at).toEqual(after.routed_at);
    // moving the invoice to another document routes that one
    const other = await doc(orgA);
    await svc(() =>
      q("update public.fin_supplier_invoices set document_id = $2 where id = $1", [inv, other]),
    );
    expect((await read(other)).routed_at).not.toBeNull();
  });

  it("a voucher attaching an inbox document routes it as voucher backup", async () => {
    const d = await doc(orgA);
    await svc(() =>
      q("select public.fin_voucher_save($1, $2, null, $3::jsonb, '{}'::uuid[], $4::uuid[])", [
        orgA,
        users.fin,
        JSON.stringify({
          voucher_date: "2026-11-02",
          payee_name: "Supplier Test 20B",
          amount: 50,
          category: "Consumables",
          narration: "Synthetic 20B voucher",
        }),
        [d],
      ]),
    );
    expect(await read(d)).toMatchObject({ kind: "voucher_backup" });
    expect((await read(d)).routed_at).not.toBeNull();
  });

  it("refuses a link to a document that is not ready (still uploading, or claimed by a discard)", async () => {
    const d = await doc(orgA);
    await svc(() =>
      q("update public.fin_documents set status = 'rejected', sha256 = null where id = $1", [d]),
    );
    const err = await svc(() =>
      failure(
        "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat, document_id) values ($1, $2, 'INV-20B-X', '2026-11-01', 'Consumables', 1, 0, $3)",
        [orgA, supplier, d],
      ),
    );
    expect(hint(err)).toBe("document_unavailable");
    const pending = await doc(orgA, { status: "pending" });
    expect(
      hint(
        await svc(() =>
          failure(
            "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat, document_id) values ($1, $2, 'INV-20B-Y', '2026-11-01', 'Consumables', 1, 0, $3)",
            [orgA, supplier, pending],
          ),
        ),
      ),
    ).toBe("document_unavailable");
  });

  it("inbox documents are read by finance.inbox.manage in its own org only; nobody writes them directly", async () => {
    const inboxDoc = await doc(orgA, { email: true });
    const attached = await doc(orgA, { inbox: false, kind: "voucher_backup" });
    const otherOrg = await doc(orgB, { email: true });
    const sees = (u: string, id: string) =>
      asUser(
        c,
        users[u],
        async () => (await q("select id from public.fin_documents where id = $1", [id])).rowCount,
      );
    expect(await sees("inboxOnly", inboxDoc)).toBe(1);
    expect(await sees("inboxOnly", attached)).toBe(0); // the inbox key reads the inbox, not every finance document
    expect(await sees("inboxOnly", otherOrg)).toBe(0);
    expect(await sees("fin", inboxDoc)).toBe(1);
    expect(await sees("fm", inboxDoc)).toBe(1);
    expect(await sees("payablesOnly", attached)).toBe(1); // the 20D policy is unchanged
    expect(await sees("bob", inboxDoc)).toBe(0);
    await asUser(c, users.inboxOnly, async () => {
      expect(
        (
          await q("update public.fin_documents set kind = 'other' where id = $1", [inboxDoc]).catch(
            () => ({ rowCount: 0 }),
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await q("delete from public.fin_documents where id = $1", [inboxDoc]).catch(() => ({
            rowCount: 0,
          }))
        ).rowCount,
      ).toBe(0);
    });
    expect(await read(inboxDoc)).toMatchObject({ kind: "unclassified" });
  });
});
