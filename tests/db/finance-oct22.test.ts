/**
 * Finance's answers of 22 Oct 2026 (docs/52), migration 20261227000100: the lab matching window is 5 days by default,
 * and an organisation still on the old default (2) moves to 5 while a value Finance chose is kept. Migration
 * 20261228000100: the split approval mode and its Tally limit (the routing itself is in the phase20d scenarios run by
 * finance-payables.test.ts). Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Finance answers of 22 Oct 2026", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const windowOf = async (org: string) =>
    Number(
      (
        await svc(() =>
          q("select lab_date_window_days from public.fin_ref_finance_settings where org_id = $1", [
            org,
          ]),
        )
      ).rows[0].lab_date_window_days,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const owner = await createAuthUser(c, "owner-oct22@example.test");
    orgA = await createOrg(c, "Org A", "org-a-oct22", owner);
    orgB = await createOrg(c, "Org B", "org-b-oct22", owner);
    await svc(async () => {
      for (const org of [orgA, orgB])
        await q(
          "insert into public.fin_ref_finance_settings (org_id) values ($1) on conflict (org_id) do nothing",
          [org],
        );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("a new organisation's lab matching window is 5 days (Q39)", async () => {
    expect(await windowOf(orgA)).toBe(5);
  });

  it("the migration moves the old default to 5 and keeps a value Finance chose", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/20261227000100_finance_reporting_rules_oct22.sql",
      "utf8",
    );
    const update =
      /update public\.fin_ref_finance_settings set lab_date_window_days = 5[^;]*;/.exec(sql)![0];
    await svc(async () => {
      await q(
        "update public.fin_ref_finance_settings set lab_date_window_days = 2 where org_id = $1",
        [orgA],
      );
      await q(
        "update public.fin_ref_finance_settings set lab_date_window_days = 3 where org_id = $1",
        [orgB],
      );
      await q(update);
    });
    expect(await windowOf(orgA)).toBe(5);
    expect(await windowOf(orgB)).toBe(3);
  });

  it("accepts the split approval mode with a positive Tally limit (default 5,000) and refuses anything else", async () => {
    const code = async (sql: string) => {
      try {
        await svc(() => q(sql, [orgA]));
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    const limit = await svc(() =>
      q(
        "select tally_approval_max::float8 as m from public.fin_ref_finance_settings where org_id = $1",
        [orgA],
      ),
    );
    expect(limit.rows[0].m).toBe(5000);
    expect(
      await code(
        "update public.fin_ref_finance_settings set approval_mode = 'split' where org_id = $1",
      ),
    ).toBe("ok");
    expect(
      await code(
        "update public.fin_ref_finance_settings set approval_mode = 'cfo' where org_id = $1",
      ),
    ).toBe("23514");
    expect(
      await code(
        "update public.fin_ref_finance_settings set tally_approval_max = 0 where org_id = $1",
      ),
    ).toBe("23514");
    await svc(() =>
      q("update public.fin_ref_finance_settings set approval_mode = 'pulse' where org_id = $1", [
        orgA,
      ]),
    );
  });
});
