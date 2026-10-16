/**
 * OQ-162: a finance branch keeps the other names Unite has used for it (`unite_clinic_aliases`), so a renamed clinic
 * stays in its branch when reports derive the branch at read time; one name never belongs to two branches.
 * Synthetic data only. Needs TEST_DATABASE_URL.
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

const OLD = "Synthetic Clinic - Old Name";
const NEW = "Synthetic Clinic - New Name";

describe.skipIf(!TEST_DATABASE_URL)("Unite clinic name aliases per branch", () => {
  let c: Client;
  let org: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const total = async (branch: string | null) =>
    svc(async () => {
      const { rows } = await q(
        "select public.fin_collections_inputs($1, '2026-09-01', $2, null) as j",
        [org, branch],
      );
      return rows[0].j.total as { rows: number; net: number };
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const alice = await createAuthUser(c, "alice-alias@example.test");
    org = await createOrg(c, "Org Alias", "org-alias", alice);
    await svc(async () => {
      await q(
        `insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name) values ($1, 'S1', 'Shore', $2)`,
        [org, NEW],
      );
      await q(
        `insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name) values ($1, 'M1', 'Meadow', 'Synthetic Clinic - Meadow')`,
        [org],
      );
      const { rows: up } = await q(
        `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
         values ($1, '2026-09-01', '2026-09-30', $2, 'committed', true, now()) returning id`,
        [org, "a".repeat(64)],
      );
      let n = 0;
      for (const [clinic, net] of [
        [OLD, 100],
        [NEW, 50],
      ] as const)
        await q(
          `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, invoice_date, clinic_name,
             doctor_name, doctor_key, net, total, is_current)
           values ($1, $2, $3, '2026-09-10', '2026-09-10', $4, 'Dr Synthetic', 'synthetic', $5, $5, true)`,
          [org, up[0].id, ++n, clinic, net],
        );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("an old name counts in the branch only once it is listed as an alias", async () => {
    expect((await total("S1")).net).toBe(50);
    await svc(() =>
      q(
        "update public.fin_ref_branches set unite_clinic_aliases = $2 where org_id = $1 and code = 'S1'",
        [org, [` ${OLD} `, OLD, "", NEW]],
      ),
    );
    const { rows } = await svc(() =>
      q(
        "select unite_clinic_aliases from public.fin_ref_branches where org_id = $1 and code = 'S1'",
        [org],
      ),
    );
    expect(rows[0].unite_clinic_aliases).toEqual([OLD]); // trimmed, deduplicated, long name dropped
    expect((await total("S1")).net).toBe(150);
    expect((await total("M1")).net).toBe(0);
    expect((await total(null)).net).toBe(150);
  });

  it("refuses a name that already belongs to another branch, either way round", async () => {
    await expect(
      svc(() =>
        q(
          "update public.fin_ref_branches set unite_clinic_aliases = $2 where org_id = $1 and code = 'M1'",
          [org, [OLD]],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      svc(() =>
        q(
          "update public.fin_ref_branches set unite_clinic_long_name = $2 where org_id = $1 and code = 'M1'",
          [org, OLD],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      svc(() =>
        q(
          "update public.fin_ref_branches set unite_clinic_aliases = $2 where org_id = $1 and code = 'M1'",
          [org, Array.from({ length: 11 }, (_, i) => `Clinic ${i}`)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
