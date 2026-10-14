/**
 * Phase D: Ctrl+K record search against a real Postgres through PostgREST. Patients, enquiries and tasks are found by
 * name, phone, number, title and subject; soft-deleted, merged and erased rows and other orgs' rows never show; each
 * kind needs its own view key; enquiries follow the restricted enquiry view and the branch rule, tasks the branch rule;
 * at most five per kind. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT. Synthetic data only
 * (names like "Layla Demo-07", numbers in the reserved +44 7700 900xxx range).
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { CurrentMember } from "@/lib/auth/session";
import { parseRecordQuery } from "@/lib/shell/record-search";
import { searchRecords } from "@/lib/shell/record-search-server";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("record search", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let otherOrg: string;
  let owner: string;
  const loc: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", params)).rows[0].id;

  /** A member as the session would load it (permissions, branch access, enquiry scope). */
  const member = (
    permissions: string[],
    extra: Partial<Pick<CurrentMember, "branchScope" | "branchIds" | "enquiryScope">> = {},
  ): CurrentMember =>
    ({
      userId: owner,
      orgId: org,
      roleId: "r",
      status: "active",
      permissions,
      roleName: "Test",
      enquiryScope: "all",
      branchScope: "all",
      branchIds: [],
      homeLocationId: null,
      org: { id: org, timezone: "Asia/Dubai", settings: {} },
      ...extra,
    }) as unknown as CurrentMember;

  const search = async (m: CurrentMember, q: string) =>
    (await searchRecords(admin, m, parseRecordQuery(q)!)).map((r) => `${r.kind}:${r.label}`);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as AdminClient;
    owner = await createAuthUser(c, "owner-search@example.test");
    const stranger = await createAuthUser(c, "other-search@example.test");
    org = await createOrg(c, "Search Org", "search-org", owner);
    otherOrg = await createOrg(c, "Other Org", "other-search-org", stranger);
    await asServiceRole(c, async () => {
      loc.north = await one("insert into public.locations (org_id, name) values ($1, 'North')", [
        org,
      ]);
      loc.south = await one("insert into public.locations (org_id, name) values ($1, 'South')", [
        org,
      ]);
      const contact = (o: string, first: string, last: string, phone: string | null) =>
        one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, $2, $3, $4)",
          [o, first, last, phone],
        );
      ids.layla = await contact(org, "Layla", "Demo-07", "+447700900107");
      ids.deleted = await contact(org, "Layla", "Demo-08", "+447700900108");
      ids.merged = await contact(org, "Layla", "Demo-09", "+447700900109");
      ids.erased = await contact(org, "Layla", "Demo-10", "+447700900110");
      await contact(otherOrg, "Layla", "Demo-11", "+447700900111");
      for (let i = 20; i < 28; i++) await contact(org, "Omar", `Demo-${i}`, `+4477009001${i}`);
      await c.query("update public.contacts set deleted_at = now() where id = $1", [ids.deleted]);
      await c.query("update public.contacts set merged_into_id = $2 where id = $1", [
        ids.merged,
        ids.layla,
      ]);
      await c.query("update public.contacts set erased_at = now() where id = $1", [ids.erased]);

      const pipeline = await one(
        "insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true)",
        [org],
      );
      const stage = await one(
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
        [org, pipeline],
      );
      const enquiry = (title: string, location: string | null, assignee: string | null) =>
        one(
          `insert into public.enquiries (org_id, pipeline_id, stage_id, title, location_id, assignee_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [org, pipeline, stage, title, location, assignee],
        );
      ids.enqNorth = await enquiry("Knee review north", loc.north, owner);
      ids.enqSouth = await enquiry("Knee review south", loc.south, null);
      ids.enqDeleted = await enquiry("Knee review deleted", null, owner);
      await c.query("update public.enquiries set deleted_at = now() where id = $1", [
        ids.enqDeleted,
      ]);

      const task = (subject: string, location: string | null) =>
        one(
          "insert into public.tasks (org_id, subject, due_at, location_id) values ($1, $2, now() + interval '1 day', $3)",
          [org, subject, location],
        );
      ids.taskNorth = await task("Call back about knee", loc.north);
      ids.taskSouth = await task("Call back about knee south", loc.south);
      ids.taskNone = await task("Call back about knee, no branch", null);
      ids.taskDeleted = await task("Call back about knee, deleted", null);
      await c.query("update public.tasks set deleted_at = now() where id = $1", [ids.taskDeleted]);
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const all = ["contacts.view", "enquiries.view", "tasks.view"];

  it("finds a patient by name or phone, never a deleted, merged, erased or other org's record", async () => {
    expect(await search(member(all), "Layla")).toEqual(["contact:Layla Demo-07"]);
    expect(await search(member(all), "+44 7700 900107")).toEqual(["contact:Layla Demo-07"]);
    expect(await search(member(all), "900107")).toEqual(["contact:Layla Demo-07"]);
    expect(await search(member(all), "Demo-08")).toEqual([]);
    expect(await search(member(all), "Demo-11")).toEqual([]);
  });

  it("caps each kind at five", async () => {
    expect((await search(member(all), "Omar")).length).toBe(5);
  });

  it("finds enquiries by number or title and tasks by subject, skipping deleted ones", async () => {
    const res = await search(member(all), "knee");
    expect(res.filter((r) => r.startsWith("enquiry:")).sort()).toEqual([
      "enquiry:Knee review north",
      "enquiry:Knee review south",
    ]);
    expect(res.filter((r) => r.startsWith("task:")).sort()).toEqual([
      "task:Call back about knee",
      "task:Call back about knee south",
      "task:Call back about knee, no branch",
    ]);
    const n = (
      await c.query<{ number: string }>("select number::text from public.enquiries where id = $1", [
        ids.enqSouth,
      ])
    ).rows[0].number;
    expect(await search(member(all), `#${n}`)).toContain("enquiry:Knee review south");
  });

  it("needs each kind's own view key", async () => {
    expect(await search(member(["tasks.view"]), "Layla")).toEqual([]);
    const tasksOnly = await search(member(["tasks.view"]), "knee");
    expect(tasksOnly.every((r) => r.startsWith("task:"))).toBe(true);
    expect(await search(member([]), "knee")).toEqual([]);
  });

  it("follows the branch rule for enquiries and tasks, and the restricted enquiry view", async () => {
    const north = member(all, { branchScope: "selected", branchIds: [loc.north] });
    const res = await search(north, "knee");
    expect(res).toContain("enquiry:Knee review north");
    expect(res).not.toContain("enquiry:Knee review south");
    expect(res).toContain("task:Call back about knee");
    expect(res).toContain("task:Call back about knee, no branch");
    expect(res).not.toContain("task:Call back about knee south");
    // own enquiries only (the membership's scope, as RLS reads it): the unassigned south enquiry is hidden
    const setScope = (scope: string) =>
      asServiceRole(c, () =>
        c.query(
          "update public.memberships set enquiry_scope = $3 where org_id = $1 and user_id = $2",
          [org, owner, scope],
        ),
      );
    await setScope("own");
    try {
      const own = await search(member(all, { enquiryScope: "own" }), "knee review");
      expect(own).toEqual(["enquiry:Knee review north"]);
    } finally {
      await setScope("all");
    }
  });

  it("logs nothing but counts", async () => {
    await c.query(
      "update public.orgs set settings = jsonb_set(coalesce(settings, '{}'), '{security}', '{\"list_sample_rate\": 1}') where id = $1",
      [org],
    );
    const m = member(all);
    (m.org as { settings: unknown }).settings = { security: { list_sample_rate: 1 } };
    await search(m, "Layla");
    const rows = await asServiceRole(
      c,
      async () =>
        (
          await c.query<{ entity: string; action: string; detail: unknown }>(
            "select entity, action, detail from public.record_access_log where org_id = $1 and action = 'search'",
            [org],
          )
        ).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/Layla|9001/);
  });
});
