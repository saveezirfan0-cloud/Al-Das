/**
 * import_runs (docs/45 P0 follow-up): counts of each importer run, service role only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMigrationFacts } from "@/lib/migration/status-server";
import type { AdminClient } from "@/lib/supabase/admin";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("import_runs", () => {
  let c: Client;
  let org: string;
  let owner: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const counters = JSON.stringify({ read: 10, created: 9, failed: 0 });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-ir@example.test");
    org = await createOrg(c, "Org IR", "org-ir", owner);
  });
  afterAll(async () => {
    await c?.end();
  });

  const insert = (extra = "") =>
    q(
      `insert into public.import_runs (org_id, source, entity, label, dry_run, run_at, counters)
       values ($1, 'sanoflow', 'contact', 'Sanoflow contacts', false, '2026-10-14T09:00:00Z', $2::jsonb) ${extra}`,
      [org, counters],
    );

  it("records a run once: the same run recorded again is a no-op", async () => {
    await asServiceRole(c, async () => {
      await insert("on conflict (org_id, source, entity, run_at, dry_run) do nothing");
      await insert("on conflict (org_id, source, entity, run_at, dry_run) do nothing");
      const { rows } = await q(
        "select count(*)::int as n from public.import_runs where org_id = $1",
        [org],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  it("refuses an unknown source and a counters value that is not an object", async () => {
    await asServiceRole(c, async () => {
      await expect(
        q(
          `insert into public.import_runs (org_id, source, entity, label, dry_run, run_at, counters)
           values ($1, 'excel', 'x', 'x', false, now(), '{}')`,
          [org],
        ),
      ).rejects.toThrow();
      await expect(
        q(
          `insert into public.import_runs (org_id, source, entity, label, dry_run, run_at, counters)
           values ($1, 'airtable', 'x', 'x', false, now(), '[1]')`,
          [org],
        ),
      ).rejects.toThrow();
    });
  });

  it("is invisible to signed-in users", async () => {
    await asUser(c, owner, async () => {
      await expect(q("select * from public.import_runs")).rejects.toThrow(/permission denied/);
    });
  });

  it("feeds the status page loader: newest real and dry run per entity", async () => {
    await asServiceRole(c, async () => {
      await q(
        `insert into public.import_runs (org_id, source, entity, label, dry_run, run_at, counters) values
           ($1, 'sanoflow', 'contact', 'Sanoflow contacts', true, '2026-10-20T09:00:00Z', '{"read": 50}'::jsonb),
           ($1, 'sanoflow', 'contact', 'Sanoflow contacts', false, '2026-10-01T09:00:00Z', '{"read": 5}'::jsonb)
         on conflict do nothing`,
        [org],
      );
    });
    // a minimal supabase-js look-alike for the three reads the loader makes
    const rows = (
      await asServiceRole(c, () =>
        q(
          "select source, entity, dry_run, run_at, counters from public.import_runs where org_id = $1 order by run_at desc",
          [org],
        ),
      )
    ).rows;
    const admin = {
      rpc: async () => ({ data: { refs: {} }, error: null }),
      from(table: string) {
        const b: Record<string, unknown> = {};
        const res = {
          data:
            table === "import_runs"
              ? rows.map((r) => ({ ...r, run_at: new Date(r.run_at).toISOString() }))
              : [],
          error: null,
          count: 0,
        };
        for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve(res);
        return b;
      },
    } as unknown as AdminClient;
    const facts = await loadMigrationFacts(admin, org);
    const r = facts.runs["sanoflow/contact"]!;
    expect(r.real?.counters.read).toBe(10); // the 14 Oct run, not the older 1 Oct one
    expect(r.real?.runAt).toBe("2026-10-14T09:00:00.000Z");
    expect(r.dry?.counters.read).toBe(50);
  });
});
