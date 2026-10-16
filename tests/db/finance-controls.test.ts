/**
 * Finance controls of 16 Oct 2026 (20261209000300): the close deadline by calendar day and the e-mail trail steps in
 * the close checklist. Synthetic data only. Needs TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("finance controls (16 Oct 2026)", () => {
  let c: Client;
  let org: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const alice = await createAuthUser(c, "alice-controls@example.test");
    org = await createOrg(c, "Org Controls", "org-controls", alice);
  });

  afterAll(async () => {
    await c?.end();
  });

  it("defaults the close deadline to the 10th and refuses a day that is not in every month", async () => {
    await svc(() =>
      q(
        "insert into public.fin_ref_finance_settings (org_id) values ($1) on conflict (org_id) do nothing",
        [org],
      ),
    );
    const { rows } = await svc(() =>
      q("select close_deadline_day from public.fin_ref_finance_settings where org_id = $1", [org]),
    );
    expect(rows[0].close_deadline_day).toBe(10);
    await expect(
      svc(() =>
        q("update public.fin_ref_finance_settings set close_deadline_day = 29 where org_id = $1", [
          org,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await svc(() =>
      q("update public.fin_ref_finance_settings set close_deadline_day = null where org_id = $1", [
        org,
      ]),
    );
  });

  it("adds the e-mail trail steps and keeps every existing step as Finance edited it", async () => {
    await svc(() => q("delete from public.fin_close_steps where org_id = $1", [org]));
    await svc(() =>
      q(
        "insert into public.fin_close_steps (org_id, code, title, due_wd) values ($1, 'DRAFT_ACCOUNTS', 'Edited by Finance', 5)",
        [org],
      ),
    );
    const { rows: seeded } = await svc(() =>
      q("select public.fin_close_seed_steps($1) as n", [org]),
    );
    expect(seeded[0].n).toBe(12);
    const { rows } = await svc(() =>
      q(
        "select code, title, due_wd, depends_on from public.fin_close_steps where org_id = $1 order by sort_order",
        [org],
      ),
    );
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by.DRAFT_ACCOUNTS).toMatchObject({ title: "Edited by Finance", due_wd: 5 });
    expect(by.REVENUE_SUBMIT).toMatchObject({ due_wd: 4 });
    expect(by.COSTS_SUBMIT).toMatchObject({ due_wd: 4 });
    expect(by.PACK_TO_CEO.depends_on).toEqual(["REVENUE_SUBMIT", "COSTS_SUBMIT", "DRAFT_ACCOUNTS"]);
    // running it again adds nothing
    const { rows: again } = await svc(() =>
      q("select public.fin_close_seed_steps($1) as n", [org]),
    );
    expect(again[0].n).toBe(0);
  });
});
