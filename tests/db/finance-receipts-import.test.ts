/**
 * Receipt register import (matching v2) in the database: the atomic function, the reference key, and who reads
 * fin_receipts. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REF_KEY_FIXTURES } from "@/lib/finance/match-keys";

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
const row = (ref: string, amount: number, date = "2026-10-05", extra: object = {}) => ({
  payment_ref: ref,
  amount,
  receipt_date: date,
  ...extra,
});

describe.skipIf(!TEST_DATABASE_URL)("Receipt register import (matching v2)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
  const run = (org: string, file: string, rows: unknown[]) =>
    svc(() =>
      q("select public.fin_receipts_import($1, null, 'register.csv', $2, $3::jsonb, $4) as r", [
        org,
        sha(file),
        JSON.stringify(rows),
        users.viewer,
      ]),
    );
  const stored = async (org: string) =>
    Number(
      (
        await svc(() =>
          q("select count(*)::int n from public.fin_receipts where org_id = $1", [org]),
        )
      ).rows[0].n,
    );
  const imports = async (org: string) =>
    Number(
      (
        await svc(() =>
          q(
            "select count(*)::int n from public.fin_bank_imports where org_id = $1 and kind = 'receipt_register'",
            [org],
          ),
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "viewer", "plain", "viewerB"])
      users[n] = await createAuthUser(c, `${n}-receipts@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      const grant = async (org: string, user: string, name: string, perms: string[]) => {
        const role = await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $2, $3::jsonb, false) returning id",
          [org, name, JSON.stringify(perms)],
        );
        await q("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
          org,
          user,
          role.rows[0].id,
        ]);
      };
      await grant(orgA, users.viewer, "Matching viewer", ["finance.matching.view"]);
      await grant(orgA, users.plain, "Plain", ["contacts.view"]);
      await grant(orgB, users.viewerB, "Matching viewer B", ["finance.matching.view"]);
    });
  });
  afterAll(async () => {
    await c.end();
  });

  it("stores rows and normalises the reference key", async () => {
    const res = await run(orgA, "f1", [
      row("INS/2026/0045", 100.5, "2026-10-05", {
        payer: " syn insurer ",
        receipt_no: "RC1",
        bank_name: "Synth Bank",
      }),
      row("000123", 250),
      row("ra-0001", 75),
    ]);
    expect(res.rows[0].r).toMatchObject({ inserted: 3, already_stored: 0 });
    const { rows } = await svc(() =>
      q(
        "select payment_ref, ref_key, payer_key, amount::text, receipt_no from public.fin_receipts where org_id = $1 order by ref_key",
        [orgA],
      ),
    );
    expect(rows.map((r) => r.ref_key)).toEqual(["123", "INS20260045", "RA0001"]);
    expect(rows.find((r) => r.ref_key === "INS20260045")).toMatchObject({
      payer_key: "SYN INSURER",
      amount: "100.50",
      receipt_no: "RC1",
    });
    expect(await imports(orgA)).toBe(1);
  });

  it("refuses the same file twice", async () => {
    const e = await err(run(orgA, "f1", [row("NEW-1", 10)]));
    expect(e?.code).toBe("23505");
    expect(await stored(orgA)).toBe(3);
  });

  it("skips overlapping rows with identical figures and reports them", async () => {
    const res = await run(orgA, "f2", [
      row("ins 2026 0045", 100.5),
      row("0123", 250),
      row("NEW-2", 40, "2026-10-06"),
    ]);
    expect(res.rows[0].r).toMatchObject({ inserted: 1, already_stored: 2 });
    expect(await stored(orgA)).toBe(4);
  });

  it("collapses a repeated reference with the same figures inside one file", async () => {
    const res = await run(orgA, "f3", [row("DUP-1", 5), row("dup 1", 5)]);
    expect(res.rows[0].r).toMatchObject({ inserted: 1, already_stored: 0 });
  });

  it("refuses a repeated reference with different figures inside one file", async () => {
    const before = await stored(orgA);
    const e = await err(run(orgA, "f4", [row("DUP-9", 5), row("DUP9", 6), row("OK-9", 1)]));
    expect(e?.code).toBe("23514");
    expect(await stored(orgA)).toBe(before);
  });

  it("refuses the whole file when a stored reference comes with a different amount, storing nothing", async () => {
    const before = await stored(orgA);
    const importsBefore = await imports(orgA);
    const e = await err(run(orgA, "f5", [row("FRESH-1", 10), row("RA-0001", 76)]));
    expect(e?.code).toBe("23514");
    expect(e?.message).toMatch(/already stored with a different amount/);
    expect(await stored(orgA)).toBe(before);
    expect(await imports(orgA)).toBe(importsBefore);
  });

  it("refuses bad rows and bad sizes", async () => {
    for (const bad of [
      row("", 10),
      row("---", 10),
      row("Z-1", 0),
      row("Z-1", -5),
      { payment_ref: "Z-2", receipt_date: "2026-10-05" },
      { payment_ref: "Z-3", amount: 5 },
    ])
      expect((await err(run(orgA, `bad-${JSON.stringify(bad)}`, [bad])))?.code).toBe("23514");
    expect((await err(run(orgA, "empty", [])))?.code).toBe("22023");
    expect((await err(run(orgA, "notarray", {} as never)))?.code).toBe("22023");
  });

  it("reads: matching.view sees own org only, others see nothing, nobody writes directly", async () => {
    await run(orgB, "fb", [row("B-ONLY", 9)]);
    const a = await asUser(c, users.viewer, () => q("select org_id from public.fin_receipts"));
    expect(a.rows.length).toBeGreaterThan(0);
    expect(new Set(a.rows.map((r) => r.org_id))).toEqual(new Set([orgA]));
    const b = await asUser(c, users.viewerB, () => q("select org_id from public.fin_receipts"));
    expect(new Set(b.rows.map((r) => r.org_id))).toEqual(new Set([orgB]));
    expect(
      (await asUser(c, users.plain, () => q("select 1 from public.fin_receipts"))).rows,
    ).toHaveLength(0);
    expect(
      (
        await asUser(c, users.alice, () =>
          q("select 1 from public.fin_receipts where org_id = $1", [orgB]),
        )
      ).rows,
    ).toHaveLength(0);

    const imp = await asUser(c, users.viewer, () =>
      q("select id from public.fin_bank_imports where kind = 'receipt_register'"),
    );
    expect(imp.rows.length).toBeGreaterThan(0);

    const ins = await asUser(c, users.viewer, () =>
      err(
        q(
          "insert into public.fin_receipts (org_id, import_id, row_no, payment_ref, ref_key, amount, receipt_date) select org_id, id, 99, 'X', 'X', 1, now()::date from public.fin_bank_imports limit 1",
        ),
      ),
    );
    expect(ins).not.toBeNull();
    const rpc = await asUser(c, users.viewer, () =>
      err(
        q("select public.fin_receipts_import($1, null, 'x.csv', 'h', '[]'::jsonb, $2)", [
          orgA,
          users.viewer,
        ]),
      ),
    );
    expect(rpc?.code).toBe("42501");
  });

  it("fin_ref_key matches the TypeScript fixtures", async () => {
    for (const [input, expected] of REF_KEY_FIXTURES) {
      const { rows } = await svc(() => q("select public.fin_ref_key($1) as k", [input]));
      expect(rows[0].k, JSON.stringify(input)).toBe(expected);
    }
  });
});
