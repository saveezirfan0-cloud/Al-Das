/**
 * Phase 15: the "who changed it" path end to end. createAdminClient(actorId) sends an x-pulse-actor header;
 * PostgREST exposes it to the record_history trigger as request.headers. This test goes through a real
 * PostgREST (TEST_POSTGREST_URL / TEST_SERVICE_JWT, see supabase/test/README.md) and the real admin factory.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "record_history actor through PostgREST",
  () => {
    let c: Client;
    let alice: string;
    let orgA: string;
    let createAdminClient: (actorId?: string | null) => import("@/lib/supabase/admin").AdminClient;

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      orgA = await createOrg(c, "Org A", "org-a", alice);
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-test-job-secret";
      ({ createAdminClient } = await import("@/lib/supabase/admin"));
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    const history = async (id: string) =>
      (
        await c.query<{ op: string; actor_id: string | null }>(
          "select op, actor_id from public.record_history where record_id = $1 order by id",
          [id],
        )
      ).rows;

    it("attributes a write made with the actor-stamped client to that user", async () => {
      const admin = createAdminClient(alice);
      const { data, error } = await admin
        .from("tasks")
        .insert({ org_id: orgA, subject: "From the app", due_at: new Date().toISOString() })
        .select("id")
        .single();
      expect(error).toBeNull();
      await admin.from("tasks").update({ subject: "Edited" }).eq("id", data!.id);
      expect(await history(data!.id)).toEqual([
        { op: "insert", actor_id: alice },
        { op: "update", actor_id: alice },
      ]);
    });

    it("attributes a write made with the plain admin client to System", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("tasks")
        .insert({ org_id: orgA, subject: "From a job", due_at: new Date().toISOString() })
        .select("id")
        .single();
      expect(await history(data!.id)).toEqual([{ op: "insert", actor_id: null }]);
    });

    it("falls back to the shared client when the actor id is not a uuid (no header injection)", async () => {
      const admin = createAdminClient("alice'; drop table tasks; --");
      const { data, error } = await admin
        .from("tasks")
        .insert({ org_id: orgA, subject: "Odd actor", due_at: new Date().toISOString() })
        .select("id")
        .single();
      expect(error).toBeNull();
      expect(await history(data!.id)).toEqual([{ op: "insert", actor_id: null }]);
    });
  },
);
