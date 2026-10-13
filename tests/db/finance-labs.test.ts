/**
 * Slice 20E: lab and referral reconciliation in the database. Who reads (Finance, the CEO; not Billing, nobody in another
 * org), that nobody writes directly, service-role-only functions, the Unite lines the matcher sees (codes through the CPT
 * mapping; deleted invoices, superseded lines and other orgs excluded), the atomic import (duplicate file, wrong layout,
 * dates outside the month, a name where a PIN belongs refused), a full month through the pure rules (review freezes the
 * figures with their sha256), two-person posting into fin_doctor_charges, idempotent re-posting, reopening, the child
 * guards, the locked month and the grant block. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import {
  lineKey,
  reconcileStatement,
  statementFigures,
  uniteKey,
  type UniteLine,
} from "@/lib/finance/labs";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("Finance labs and referrals (slice 20E)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let sendOut: string;
  let inHouse: string;
  let hospital: string;
  let invoiceFormat: string;
  let activityFormat: string;
  let statementOct: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
  const importRows = (
    provider: string,
    month: string,
    format: string,
    rows: unknown[],
    hash: string,
  ) =>
    svc(() =>
      q("select public.fin_provider_import($1, $2, $3, $4, 'lab.csv', $5, $6::jsonb, $7) as id", [
        orgA,
        provider,
        month,
        format,
        hash,
        JSON.stringify(rows),
        users.fin,
      ]),
    );
  const row = (over: Record<string, unknown>) => ({
    service_date: "2026-10-05",
    code: "85025",
    patient_pin: null,
    doctor_dha_id: null,
    branch_code: null,
    result_date: null,
    amount: 10,
    invoice_no: null,
    ...over,
  });
  const charges = (statementId: string) =>
    svc(() =>
      q(
        "select doctor_dha_id, kind, amount::float as amount, source from public.fin_doctor_charges where reference = $1 order by doctor_dha_id",
        [statementId],
      ),
    ).then((r) => r.rows);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "fin2", "ceo", "billing"])
      users[n] = await createAuthUser(c, `${n}-labs@example.test`);
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
      await member("fin2", "Finance");
      await member("ceo", "CEO");
      await member("billing", "Billing");

      const one = async (sql: string, p: unknown[]) =>
        (await q(sql + " returning id", p)).rows[0].id as string;
      sendOut = await one(
        "insert into public.fin_providers (org_id, name, kind) values ($1, 'Synthetic Send-out Lab', 'send_out_lab')",
        [orgA],
      );
      inHouse = await one(
        "insert into public.fin_providers (org_id, name, kind, fixed_monthly_fee) values ($1, 'Synthetic In-house Lab', 'in_house_lab', 25000)",
        [orgA],
      );
      hospital = await one(
        "insert into public.fin_providers (org_id, name, kind) values ($1, 'Synthetic Hospital', 'hospital')",
        [orgA],
      );
      await one(
        "insert into public.fin_providers (org_id, name, kind) values ($1, 'Synthetic Send-out Lab', 'send_out_lab')",
        [orgB],
      );
      invoiceFormat = await one(
        `insert into public.fin_import_formats (org_id, kind, name, mapping, date_format) values ($1, 'provider_invoice', 'Lab invoice', '{"service_date":"Date","test_code":"Code","amount":"Charge"}'::jsonb, 'YYYY-MM-DD')`,
        [orgA],
      );
      activityFormat = await one(
        `insert into public.fin_import_formats (org_id, kind, name, mapping, date_format) values ($1, 'lab_activity', 'Lab activity', '{"service_date":"Date","test_code":"Code"}'::jsonb, 'YYYY-MM-DD')`,
        [orgA],
      );
      for (const [code, days, price] of [
        ["85025", 2, 35],
        ["80053", 3, 80],
      ] as const)
        await q(
          "insert into public.fin_ref_provider_tests (org_id, provider_id, code, expected_days, agreed_price) values ($1, $2, $3, $4, $5)",
          [orgA, sendOut, code, days, price],
        );
      await q(
        "insert into public.fin_ref_services (org_id, item_code, cpt_code) values ($1, 'LAB-CMP', '80053')",
        [orgA],
      );

      // Unite: billed lines (the doctor basis is unset, so the invoice doctor applies)
      const invoice = async (
        org: string,
        n: string,
        pin: string,
        date: string,
        doctor: string,
        item: string,
        net: number,
        opts: { deleted?: boolean; current?: boolean } = {},
      ) => {
        const id = await one(
          "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, net, total, patient_pin, doctor_dha_id, is_deleted, record_hash) values ($1, $2, $3, 'P', $4, $4, $5, $6, $7, 'h')",
          [org, n, date, net, pin, doctor, opts.deleted ?? false],
        );
        await q(
          "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, line_net, is_current) values ($1, $2, $3, 1, $4, $5, $6)",
          [org, id, `${n}|1`, item, net, opts.current ?? true],
        );
      };
      await invoice(orgA, "SYN/1", "SYN-001", "2026-10-05", "DHA-SYN-1", "85025", 50);
      await invoice(orgA, "SYN/2", "SYN-002", "2026-10-06", "DHA-SYN-2", "LAB-CMP", 120);
      await invoice(orgA, "SYN/3", "SYN-003", "2026-10-10", "DHA-SYN-1", "85025", 50);
      await invoice(orgA, "SYN/4", "SYN-004", "2026-10-11", "DHA-SYN-1", "85025", 50, {
        deleted: true,
      });
      await invoice(orgA, "SYN/5", "SYN-005", "2026-10-12", "DHA-SYN-1", "85025", 50, {
        current: false,
      });
      await invoice(orgA, "SYN/6", "SYN-006", "2026-12-01", "DHA-SYN-1", "85025", 50);
      await invoice(orgB, "SYN/B1", "SYN-001", "2026-10-05", "DHA-SYN-1", "85025", 50);
    });

    statementOct = (
      await importRows(
        sendOut,
        "2026-10-01",
        invoiceFormat,
        [
          row({ patient_pin: "SYN-001", amount: 35 }),
          row({ service_date: "2026-10-07", code: "80053", patient_pin: "SYN-002", amount: 90 }),
          row({
            service_date: "2026-10-08",
            code: "84443",
            patient_pin: "SYN-007",
            doctor_dha_id: "DHA-SYN-2",
            amount: 60,
          }),
        ],
        sha("oct-1"),
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const uniteLines = async (codes: string[]) =>
    (
      await svc(() =>
        q("select public.fin_lab_unite_lines($1, '2026-09-28', '2026-11-03', $2) as j", [
          orgA,
          codes,
        ]),
      )
    ).rows[0].j as Array<Record<string, unknown>>;

  it("Finance and the CEO read the rows; Billing, another org and a stranger see nothing; nobody writes directly", async () => {
    const n = async (t: string) =>
      Number((await q(`select count(*) from public.${t} where org_id = $1`, [orgA])).rows[0].count);
    for (const who of ["fin", "ceo"])
      await asRole(who, async () => {
        expect(await n("fin_providers"), who).toBe(3);
        expect(await n("fin_provider_lines"), who).toBe(3);
        expect(await n("fin_provider_statements"), who).toBe(1);
        expect(await n("fin_ref_provider_tests"), who).toBe(2);
        expect(await n("fin_import_formats"), who).toBe(2); // the lab keys read the lab layouts
      });
    for (const who of ["billing", "bob"])
      await asRole(who, async () => {
        for (const t of [
          "fin_providers",
          "fin_provider_lines",
          "fin_provider_statements",
          "fin_provider_files",
          "fin_provider_notes",
          "fin_ref_provider_tests",
        ])
          expect(await n(t), `${who} ${t}`).toBe(0);
      });
    await asRole("fin", async () => {
      expect(
        await err(
          q("insert into public.fin_providers (org_id, name, kind) values ($1, 'X', 'other')", [
            orgA,
          ]),
        ),
      ).toMatchObject({ code: "42501" });
      const u = await q(
        "update public.fin_provider_statements set status = 'reviewed' where org_id = $1",
        [orgA],
      );
      expect(u.rowCount).toBe(0);
    });
  });

  it("the functions are for the service role only", async () => {
    const fns = ["fin_lab_unite_lines", "fin_provider_import", "fin_lab_post", "fin_lab_reopen"];
    const { rows } = await q(
      `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any ($1)`,
      [fns],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...fns].sort());
    for (const r of rows)
      expect([r.name, r.auth, r.anon, r.svc]).toEqual([r.name, false, false, true]);
  });

  it("gives the matcher current lines of live invoices by item code or the CPT of the item, in range, in the org", async () => {
    const lines = await uniteLines(["85025", "80053"]);
    expect(
      lines.map((l) => [l.pin, l.date, l.item_code, l.ref_cpt, Number(l.net), l.doctor]),
    ).toEqual([
      ["SYN-001", "2026-10-05", "85025", null, 50, "DHA-SYN-1"],
      ["SYN-002", "2026-10-06", "LAB-CMP", "80053", 120, "DHA-SYN-2"],
      ["SYN-003", "2026-10-10", "85025", null, 50, "DHA-SYN-1"],
    ]);
    expect(await uniteLines(["99213"])).toEqual([]);
  });

  describe("the import", () => {
    it("keeps the file's extension only, never its name", async () => {
      const names = (
        await svc(() =>
          q(
            "select f.file_name from public.fin_provider_files f where f.statement_id = $1",
            [statementOct],
          ),
        )
      ).rows.map((r) => r.file_name);
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n).toBe("csv");
      await expect(
        svc(() =>
          q("update public.fin_provider_files set file_name = 'Layla Demo-07 results.xlsx' where statement_id = $1", [
            statementOct,
          ]),
        ),
      ).resolves.toBeTruthy();
      const after = (
        await svc(() =>
          q("select distinct file_name from public.fin_provider_files where statement_id = $1", [statementOct]),
        )
      ).rows.map((r) => r.file_name);
      expect(after).toEqual(["xlsx"]);
    });

    it("stores sanitised rows in the provider's statement for the month, with the file's fingerprint only", async () => {
      const { rows } = await svc(() =>
        q(
          "select f.kind, f.row_count, f.total_amount::float as total, f.first_date::text, f.last_date::text, s.status from public.fin_provider_files f join public.fin_provider_statements s on s.id = f.statement_id where s.id = $1",
          [statementOct],
        ),
      );
      expect(rows).toEqual([
        {
          kind: "provider_invoice",
          row_count: 3,
          total: 185,
          first_date: "2026-10-05",
          last_date: "2026-10-08",
          status: "open",
        },
      ]);
      // a second (branch) file goes into the same statement
      const again = await importRows(
        sendOut,
        "2026-10-01",
        invoiceFormat,
        [row({ service_date: "2026-10-20", patient_pin: "SYN-008" })],
        sha("oct-2"),
      );
      expect(again.rows[0].id).toBe(statementOct);
      await svc(() =>
        q("delete from public.fin_provider_files where file_sha256 = $1", [sha("oct-2")]),
      );
    });

    it("refuses the same file twice, a layout of the wrong kind, dates outside the month, a missing amount and another org's provider", async () => {
      expect(
        await err(importRows(sendOut, "2026-10-01", invoiceFormat, [row({})], sha("oct-1"))),
      ).toMatchObject({
        code: "23505",
      });
      expect(
        await err(importRows(sendOut, "2026-10-01", activityFormat, [row({})], sha("x1"))),
      ).toMatchObject({
        code: "22023",
      });
      expect(
        await err(
          importRows(
            sendOut,
            "2026-10-01",
            invoiceFormat,
            [row({ service_date: "2026-11-01" })],
            sha("x2"),
          ),
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await err(
          importRows(
            sendOut,
            "2026-10-01",
            invoiceFormat,
            [row({ service_date: "2026-08-31" })],
            sha("x3"),
          ),
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await err(
          importRows(sendOut, "2026-10-01", invoiceFormat, [row({ amount: null })], sha("x4")),
        ),
      ).toMatchObject({ code: "23514" });
      const providerB = (
        await svc(() => q("select id from public.fin_providers where org_id = $1", [orgB]))
      ).rows[0].id;
      expect(
        await err(importRows(providerB, "2026-10-01", invoiceFormat, [row({})], sha("x5"))),
      ).toMatchObject({
        code: "22023",
      });
      // nothing half-stored
      expect(
        (
          await svc(() =>
            q("select count(*)::int as n from public.fin_provider_lines where org_id = $1", [orgA]),
          )
        ).rows[0].n,
      ).toBe(3);
    });

    it("the table refuses a name where a PIN or a code belongs (defence behind the parser)", async () => {
      for (const bad of [
        { patient_pin: "Layla Demo-07" },
        { patient_pin: "LAYLA" },
        { code: "CBC TEST" },
        { doctor_dha_id: "Dr Synthetic" },
      ])
        expect(
          await err(
            importRows(hospital, "2026-10-01", invoiceFormat, [row(bad)], sha(JSON.stringify(bad))),
          ),
          JSON.stringify(bad),
        ).toMatchObject({ code: "23514" });
    });
  });

  describe("a month from upload to posting", () => {
    let figures: ReturnType<typeof statementFigures>;
    let hash: string;

    it("the pure rules on the database rows: matched, done but not billed, billed but not on the file, price", async () => {
      const lines = (
        await svc(() =>
          q(
            "select id, service_date::text, code, patient_pin, doctor_dha_id, branch_code, result_date::text, amount::float from public.fin_provider_lines where statement_id = $1",
            [statementOct],
          ),
        )
      ).rows.map((l) => ({
        id: l.id,
        serviceDate: l.service_date,
        code: l.code,
        pin: l.patient_pin,
        doctor: l.doctor_dha_id,
        branch: l.branch_code,
        resultDate: l.result_date,
        amount: l.amount,
      }));
      const unite: UniteLine[] = (await uniteLines(["85025", "80053", "84443"])).map((u) => ({
        id: String(u.id),
        invoiceId: String(u.invoice_id),
        pin: (u.pin as string) ?? null,
        date: String(u.date),
        itemCode: (u.item_code as string) ?? null,
        lineCpt: (u.line_cpt as string) ?? null,
        refCpt: (u.ref_cpt as string) ?? null,
        net: Number(u.net),
        branch: (u.branch as string) ?? null,
        doctor: (u.doctor as string) ?? null,
      }));
      const tests = [
        { code: "85025", expectedDays: 2, agreedPrice: 35 },
        { code: "80053", expectedDays: 3, agreedPrice: 80 },
      ];
      const base = {
        provider: {
          id: sendOut,
          kind: "send_out_lab" as const,
          fixedFee: null,
          basis: "test_count" as const,
        },
        month: "2026-10-01",
        lines,
        unite,
        tests,
        settings: { windowDays: 2, priceTolerance: 1 },
        today: "2026-11-05",
      };
      let r = reconcileStatement({ ...base, notes: [] });
      expect(r.matched.map((m) => [m.line.pin, m.unite.pin])).toEqual([
        ["SYN-001", "SYN-001"],
        ["SYN-002", "SYN-002"],
      ]);
      expect(r.notBilled.map((n) => n.line.pin)).toEqual(["SYN-007"]);
      expect(r.notOnFile.map((n) => n.unite.pin)).toEqual(["SYN-003"]);
      expect(r.priceVariances.map((v) => v.diff)).toEqual([10]);
      expect(r.problems).toHaveLength(2);

      // the reasons, then the review
      const notBilledKey = lineKey(r.notBilled[0].line.id);
      const notOnFileKey = uniteKey(r.notOnFile[0].unite.id);
      await svc(() =>
        q(
          "insert into public.fin_provider_notes (org_id, statement_id, item_key, reason_code, decided_by) values ($1, $2, $3, 'billing_to_correct', $5), ($1, $2, $4, 'provider_error', $5)",
          [orgA, statementOct, notBilledKey, notOnFileKey, users.fin],
        ),
      );
      r = reconcileStatement({
        ...base,
        notes: [
          { itemKey: notBilledKey, code: "billing_to_correct", note: null },
          { itemKey: notOnFileKey, code: "provider_error", note: null },
        ],
      });
      expect(r.problems).toEqual([]);
      expect(r.doctors).toEqual([
        { doctor_dha_id: "DHA-SYN-1", amount: 35 },
        { doctor_dha_id: "DHA-SYN-2", amount: 150 },
      ]);
      figures = statementFigures(r, {
        statementId: statementOct,
        providerId: sendOut,
        providerKind: "send_out_lab",
        month: "2026-10-01",
      });
    });

    it("a review with open problems is refused; a review freezes the figures and stores their sha256", async () => {
      expect(
        await err(
          svc(() =>
            q(
              "update public.fin_provider_statements set status = 'reviewed', figures = $2::jsonb, prepared_by = $3 where id = $1",
              [statementOct, JSON.stringify({ ...figures, problems: ["x"] }), users.fin],
            ),
          ),
        ),
      ).toMatchObject({ code: "23514" });
      const { rows } = await svc(() =>
        q(
          "update public.fin_provider_statements set status = 'reviewed', figures = $2::jsonb, prepared_by = $3 where id = $1 returning figures_sha256, figures::text as text",
          [statementOct, JSON.stringify(figures), users.fin],
        ),
      );
      hash = rows[0].figures_sha256;
      expect(hash).toBe(sha(rows[0].text));
      // a reviewed statement takes no new reasons, files or lines, and its lines never change
      expect(
        await err(
          svc(() =>
            q(
              "insert into public.fin_provider_notes (org_id, statement_id, item_key, reason_code) values ($1, $2, $3, 'other')",
              [orgA, statementOct, lineKey("00000000-0000-4000-8000-000000000001")],
            ),
          ),
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await err(importRows(sendOut, "2026-10-01", invoiceFormat, [row({})], sha("late"))),
      ).toMatchObject({
        code: "23514",
      });
      expect(
        await err(
          svc(() =>
            q("update public.fin_provider_lines set amount = 1 where statement_id = $1", [
              statementOct,
            ]),
          ),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await err(
          svc(() => q("delete from public.fin_provider_statements where id = $1", [statementOct])),
        ),
      ).toMatchObject({ code: "42501" });
    });

    it("posting needs a different person and the fingerprint shown, and writes each doctor's lab charge", async () => {
      const post = (who: string, h: string) =>
        svc(() =>
          q("select public.fin_lab_post($1, $2, $3, $4) as r", [orgA, statementOct, h, users[who]]),
        );
      expect(await err(post("fin", hash))).toMatchObject({ code: "23514" }); // the preparer
      expect(await err(post("fin2", "0".repeat(64)))).toMatchObject({ code: "23514" });
      // the guard and the CHECK refuse a direct update by the preparer as well
      expect(
        await err(
          svc(() =>
            q(
              "update public.fin_provider_statements set status = 'posted', posted_by = $2 where id = $1",
              [statementOct, users.fin],
            ),
          ),
        ),
      ).toMatchObject({ code: "23514" });
      expect(await charges(statementOct)).toEqual([]);

      await svc(() =>
        q(
          "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount, source, created_by) values ($1, '2026-10-01', 'DHA-SYN-1', 'lab', 5, 'manual', $2)",
          [orgA, users.fin],
        ),
      );
      const first = (await post("fin2", hash)).rows[0].r;
      expect(first).toEqual({ added: 2, removed: 0 });
      expect(await charges(statementOct)).toEqual([
        { doctor_dha_id: "DHA-SYN-1", kind: "lab", amount: 35, source: "lab_recon" },
        { doctor_dha_id: "DHA-SYN-2", kind: "lab", amount: 150, source: "lab_recon" },
      ]);
      const st = (
        await svc(() =>
          q("select status, posted_by from public.fin_provider_statements where id = $1", [
            statementOct,
          ]),
        )
      ).rows[0];
      expect(st).toEqual({ status: "posted", posted_by: users.fin2 });
    });

    it("posting again replaces only this statement's charges (idempotent); manual charges stay", async () => {
      const again = (
        await svc(() =>
          q("select public.fin_lab_post($1, $2, $3, $4) as r", [
            orgA,
            statementOct,
            hash,
            users.fin2,
          ]),
        )
      ).rows[0].r;
      expect(again).toEqual({ added: 2, removed: 2 });
      expect(await charges(statementOct)).toHaveLength(2);
      const { rows } = await svc(() =>
        q(
          "select source, count(*)::int as n from public.fin_doctor_charges where org_id = $1 group by source order by source",
          [orgA],
        ),
      );
      expect(rows).toEqual([
        { source: "lab_recon", n: 2 },
        { source: "manual", n: 1 },
      ]);
    });

    it("reopening a posted statement removes its charges and clears the figures", async () => {
      await svc(() => q("select public.fin_lab_reopen($1, $2)", [orgA, statementOct]));
      expect(await charges(statementOct)).toEqual([]);
      const st = (
        await svc(() =>
          q(
            "select status, figures, figures_sha256, prepared_by, posted_by from public.fin_provider_statements where id = $1",
            [statementOct],
          ),
        )
      ).rows[0];
      expect(st).toEqual({
        status: "open",
        figures: null,
        figures_sha256: null,
        prepared_by: null,
        posted_by: null,
      });
      expect(
        await err(svc(() => q("select public.fin_lab_reopen($1, $2)", [orgA, statementOct]))),
      ).toMatchObject({
        code: "23514",
      });
      // another org cannot post or reopen it
      expect(
        await err(svc(() => q("select public.fin_lab_reopen($1, $2)", [orgB, statementOct]))),
      ).toMatchObject({ code: "22023" });
    });

    it("a hospital's costs are posted as referral charges", async () => {
      const id = (
        await importRows(
          hospital,
          "2026-10-01",
          invoiceFormat,
          [row({ doctor_dha_id: "DHA-SYN-3", amount: 400 })],
          sha("hosp"),
        )
      ).rows[0].id;
      const f = {
        version: "labs-1",
        doctors: [{ doctor_dha_id: "DHA-SYN-3", amount: 400 }],
        problems: [],
      };
      const h = (
        await svc(() =>
          q(
            "update public.fin_provider_statements set status = 'reviewed', figures = $2::jsonb, prepared_by = $3 where id = $1 returning figures_sha256",
            [id, JSON.stringify(f), users.fin],
          ),
        )
      ).rows[0].figures_sha256;
      await svc(() => q("select public.fin_lab_post($1, $2, $3, $4)", [orgA, id, h, users.fin2]));
      expect(await charges(id)).toEqual([
        { doctor_dha_id: "DHA-SYN-3", kind: "referral", amount: 400, source: "referral_recon" },
      ]);
    });
  });

  describe("a locked month", () => {
    it("refuses uploads, reasons, review, posting and reopening", async () => {
      const aug = (
        await importRows(
          inHouse,
          "2026-08-01",
          activityFormat,
          [row({ service_date: "2026-08-03", amount: null, doctor_dha_id: "DHA-SYN-1" })],
          sha("aug"),
        )
      ).rows[0].id;
      const f = {
        version: "labs-1",
        doctors: [{ doctor_dha_id: "DHA-SYN-1", amount: 25000 }],
        problems: [],
      };
      const h = (
        await svc(() =>
          q(
            "update public.fin_provider_statements set status = 'reviewed', figures = $2::jsonb, prepared_by = $3 where id = $1 returning figures_sha256",
            [aug, JSON.stringify(f), users.fin],
          ),
        )
      ).rows[0].figures_sha256;
      await svc(() =>
        q(
          `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
           values ($1, '2026-08-01', 'locked', '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'), now(), now(), now(), now())`,
          [orgA],
        ),
      );
      expect(
        await err(
          svc(() => q("select public.fin_lab_post($1, $2, $3, $4)", [orgA, aug, h, users.fin2])),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await err(svc(() => q("select public.fin_lab_reopen($1, $2)", [orgA, aug]))),
      ).toMatchObject({
        code: "42501",
      });
      expect(await charges(aug)).toEqual([]);
      expect(
        await err(
          importRows(
            sendOut,
            "2026-08-01",
            invoiceFormat,
            [row({ service_date: "2026-08-04" })],
            sha("aug-2"),
          ),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await err(
          svc(() =>
            q(
              "insert into public.fin_provider_notes (org_id, statement_id, item_key, reason_code) values ($1, $2, $3, 'provider_error')",
              [orgA, aug, lineKey("00000000-0000-4000-8000-000000000002")],
            ),
          ),
        ),
      ).toMatchObject({ code: "42501" });
    });
  });

  it("the grant block gives Finance and the Finance Manager view and manage and the CEO view, idempotently, and nothing else", async () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261105000100_finance_labs.sql"),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(block, "the grant block was not found").toBeTruthy();
    const orgC = await createOrg(c, "Org C", "org-c", users.alice);
    const names = [
      "Finance",
      "Finance Manager",
      "CEO",
      "Medical Director",
      "Billing",
      "Insurance",
      "Cost / Payroll",
    ];
    await svc(async () => {
      for (const name of names)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '[\"finance.view\"]'::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgC, name],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Custom finance', '', '[\"finance.view\"]'::jsonb, false)",
        [orgC],
      );
    });
    const read = async () =>
      Object.fromEntries(
        (
          await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
        ).rows.map((r) => [
          r.name,
          (r.permissions as string[]).filter((p) => p.startsWith("finance.labs.")).sort(),
        ]),
      );
    await svc(() => q(block!));
    const first = await read();
    for (const n of ["Finance", "Finance Manager"])
      expect(first[n], n).toEqual(["finance.labs.manage", "finance.labs.view"]);
    expect(first.CEO).toEqual(["finance.labs.view"]);
    for (const n of [
      "Medical Director",
      "Billing",
      "Insurance",
      "Cost / Payroll",
      "Custom finance",
    ])
      expect(first[n], n).toEqual([]);
    await svc(() => q(block!));
    expect(await read()).toEqual(first);
    for (const preset of FINANCE_ROLES.filter((r) => names.includes(r.name)))
      expect(
        preset.permissions.filter((p) => p.startsWith("finance.labs.")).sort(),
        preset.name,
      ).toEqual(first[preset.name]);
  });
});
