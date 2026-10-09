/**
 * The enquiry service against a real Postgres through PostgREST: embedded selects, triggers, the
 * round-robin RPC, filters and bulk operations. Runs only when TEST_DATABASE_URL,
 * TEST_POSTGREST_URL and TEST_SERVICE_JWT are set (supabase/test/README.md). Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enquiryFilterSchema, type EnquiryFilter } from "@/lib/enquiries/filter";
import {
  bulkUpdate,
  boardColumns,
  createEnquiry,
  deleteEnquiries,
  enquiriesForContact,
  enquiryTimeline,
  ensureDefaultPipelines,
  exportRows,
  getEnquiry,
  listEnquiries,
  loadPipelines,
  moveStage,
  moveToPipeline,
  setStatus,
  updateEnquiry,
  type Actor,
} from "@/lib/enquiries/service";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "enquiry service (PostgREST)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let orgA: string;
    let orgB: string;
    let alice: string;
    let bea: string;
    let bob: string;
    let actor: Actor;
    let contact1: string;
    let contact2: string;
    let contactB: string;
    let reception: string;
    let receptionStages: string[];
    let pharmacy: string;
    let id1: string;
    let id2: string;
    let team: string;

    const f = (o: object = {}): EnquiryFilter => enquiryFilterSchema.parse(o);

    async function sql<T = unknown>(q: string, params: unknown[] = []): Promise<T[]> {
      await c.query("set role service_role");
      try {
        return (await c.query(q, params)).rows as T[];
      } finally {
        await c.query("reset role");
      }
    }

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice-e@example.test");
      bea = await createAuthUser(c, "bea-e@example.test");
      bob = await createAuthUser(c, "bob-e@example.test");
      orgA = await createOrg(c, "Org A", "org-a-e", alice);
      orgB = await createOrg(c, "Org B", "org-b-e", bob);
      const roles = await sql<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await sql("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
        orgA,
        bea,
        roles[0].id,
      ]);
      contact1 = (
        await sql<{ id: string }>(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Sara', 'Example', '+971500000101') returning id",
          [orgA],
        )
      )[0].id;
      contact2 = (
        await sql<{ id: string }>(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Omar', 'Sample', '+971500000102') returning id",
          [orgA],
        )
      )[0].id;
      contactB = (
        await sql<{ id: string }>(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Other', 'Org') returning id",
          [orgB],
        )
      )[0].id;
      team = (
        await sql<{ id: string }>(
          "insert into public.teams (org_id, name, round_robin) values ($1, 'Front desk', true) returning id",
          [orgA],
        )
      )[0].id;
      await sql("insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)", [
        orgA,
        team,
        bea,
      ]);

      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      });
      actor = { orgId: orgA, userId: alice };
    });

    afterAll(async () => {
      await c?.end();
    });

    it("creates the clinic's default pipelines once", async () => {
      await ensureDefaultPipelines(admin, orgA);
      await ensureDefaultPipelines(admin, orgA);
      const pipelines = await loadPipelines(admin, orgA);
      expect(pipelines).toHaveLength(8);
      expect(pipelines[0].name).toBe("Reception");
      expect(pipelines.every((p) => p.stages.length === 3)).toBe(true);
      expect(pipelines[0].stages.map((s) => s.name)).toEqual(["New", "In progress", "Follow-up"]);
      reception = pipelines[0].id;
      receptionStages = pipelines[0].stages.map((s) => s.id);
      pharmacy = pipelines.find((p) => p.name === "Pharmacy")!.id;
      expect(await loadPipelines(admin, orgB)).toHaveLength(0);
    });

    it("creates enquiries with per-org numbers, a timeline and defaults", async () => {
      const a = await createEnquiry(admin, actor, {
        contact_id: contact1,
        pipeline_id: reception,
        title: "Knee pain consult",
        source: "Instagram",
        est_value: 250,
      });
      const b = await createEnquiry(admin, actor, {
        contact_id: contact2,
        pipeline_id: reception,
        title: "Pharmacy refill",
      });
      expect(a).toMatchObject({ ok: true, number: 1 });
      expect(b).toMatchObject({ ok: true, number: 2 });
      if (!a.ok || !b.ok) throw new Error("create failed");
      id1 = a.id;
      id2 = b.id;
      const row = await getEnquiry(admin, orgA, id1);
      expect(row).toMatchObject({
        status: "open",
        stage_id: receptionStages[0],
        stage_name: "New",
        pipeline_name: "Reception",
        patient: "Sara Example",
        phone: "+971500000101",
        source: "Instagram",
        est_value: 250,
        assignee_id: null,
      });
      const events = await enquiryTimeline(admin, orgA, id1);
      expect(events.map((e) => e.type)).toEqual(["enquiry.created"]);
      expect(events[0].detail).toBe("Created in Reception / New");
      const hist = await sql(
        "select stage_name from public.enquiry_stage_history where enquiry_id = $1",
        [id1],
      );
      expect(hist).toEqual([{ stage_name: "New" }]);
    });

    it("refuses other orgs' records and inactive pipelines", async () => {
      expect(
        await createEnquiry(admin, actor, { contact_id: contactB, pipeline_id: reception }),
      ).toEqual({ ok: false, error: "Choose a patient for this enquiry." });
      const other = await createEnquiry(
        admin,
        { orgId: orgB, userId: bob },
        { contact_id: contactB, pipeline_id: reception },
      );
      expect(other).toEqual({ ok: false, error: "Choose an active pipeline." });
      expect(await moveStage(admin, { orgId: orgB, userId: bob }, id1, receptionStages[1])).toEqual(
        { ok: false, error: "Enquiry not found." },
      );
      expect(
        await createEnquiry(admin, actor, {
          contact_id: contact1,
          pipeline_id: reception,
          assignee_id: bob,
        }),
      ).toEqual({
        ok: false,
        error: "That user is not an active member of this workspace.",
      });
    });

    it("lists with embedded names, search, sorting and paging", async () => {
      const all = await listEnquiries(admin, actor, f(), {
        page: 0,
        pageSize: 10,
        sort: "number",
        dir: "asc",
      });
      expect(all.total).toBe(2);
      expect(all.rows.map((r) => r.number)).toEqual([1, 2]);
      expect(all.rows[0].created_by_name).toContain("alice");
      const byTitle = await listEnquiries(admin, actor, f({ search: "knee" }), {
        page: 0,
        pageSize: 10,
      });
      expect(byTitle.rows.map((r) => r.id)).toEqual([id1]);
      const byName = await listEnquiries(admin, actor, f({ search: "omar" }), {
        page: 0,
        pageSize: 10,
      });
      expect(byName.rows.map((r) => r.id)).toEqual([id2]);
      const byPhone = await listEnquiries(admin, actor, f({ search: "500000101" }), {
        page: 0,
        pageSize: 10,
      });
      expect(byPhone.rows.map((r) => r.id)).toEqual([id1]);
      const byNumber = await listEnquiries(admin, actor, f({ search: "#2" }), {
        page: 0,
        pageSize: 10,
      });
      expect(byNumber.rows.map((r) => r.id)).toEqual([id2]);
      const nasty = await listEnquiries(admin, actor, f({ search: "x),status.eq.won,(y" }), {
        page: 0,
        pageSize: 10,
      });
      expect(nasty.total).toBe(0);
      const page2 = await listEnquiries(admin, actor, f(), {
        page: 1,
        pageSize: 1,
        sort: "number",
        dir: "asc",
      });
      expect(page2.rows.map((r) => r.number)).toEqual([2]);
      expect(page2.total).toBe(2);
      const badSort = await listEnquiries(admin, actor, f(), {
        page: 0,
        pageSize: 5,
        sort: "number; drop table x",
      });
      expect(badSort.total).toBe(2);
      expect(
        (await listEnquiries(admin, { orgId: orgB, userId: bob }, f(), { page: 0, pageSize: 5 }))
          .total,
      ).toBe(0);
    });

    it("moves stages, records history and rejects foreign stages", async () => {
      expect(await moveStage(admin, actor, id1, receptionStages[1])).toEqual({ ok: true });
      const row = await getEnquiry(admin, orgA, id1);
      expect(row?.stage_name).toBe("In progress");
      const hist = await sql<{ stage_name: string; left_at: string | null }>(
        "select stage_name, left_at from public.enquiry_stage_history where enquiry_id = $1 order by entered_at, stage_name",
        [id1],
      );
      expect(hist.map((h) => h.stage_name).sort()).toEqual(["In progress", "New"]);
      expect(hist.filter((h) => h.left_at === null)).toHaveLength(1);
      const pharmacyStage = (await loadPipelines(admin, orgA)).find((p) => p.id === pharmacy)!
        .stages[0].id;
      expect(await moveStage(admin, actor, id1, pharmacyStage)).toEqual({
        ok: false,
        error: "That stage is not in this pipeline.",
      });
      expect((await enquiryTimeline(admin, orgA, id1))[0]).toMatchObject({
        type: "enquiry.stage_changed",
        detail: "New → In progress",
      });
    });

    it("builds board columns with counts", async () => {
      const cols = await boardColumns(admin, actor, f({ pipeline_id: reception }), receptionStages);
      expect(cols.map((col) => [col.total, col.rows.length])).toEqual([
        [1, 1],
        [1, 1],
        [0, 0],
      ]);
      expect(cols[0].rows[0].id).toBe(id2);
    });

    it("moves between pipelines", async () => {
      expect(await moveToPipeline(admin, actor, id2, pharmacy)).toEqual({ ok: true });
      const row = await getEnquiry(admin, orgA, id2);
      expect(row).toMatchObject({ pipeline_name: "Pharmacy", stage_name: "New" });
      const t = await enquiryTimeline(admin, orgA, id2);
      expect(t[0]).toMatchObject({
        type: "enquiry.pipeline_changed",
        detail: "Reception → Pharmacy",
      });
    });

    it("handles status: reasons, closing, reopening and the Open/Closed switch", async () => {
      expect(await setStatus(admin, actor, id1, "lost", "")).toEqual({
        ok: false,
        error: "Say why this enquiry is lost.",
      });
      expect(await setStatus(admin, actor, id1, "lost", "Chose another clinic")).toEqual({
        ok: true,
      });
      const lost = await getEnquiry(admin, orgA, id1);
      expect(lost).toMatchObject({ status: "lost", lost_reason: "Chose another clinic" });
      expect(lost?.closed_at).not.toBeNull();
      expect((await listEnquiries(admin, actor, f(), { page: 0, pageSize: 10 })).total).toBe(1);
      expect(
        (
          await listEnquiries(admin, actor, f({ scope: "closed" }), { page: 0, pageSize: 10 })
        ).rows.map((r) => r.id),
      ).toEqual([id1]);
      expect(await setStatus(admin, actor, id1, "open")).toEqual({ ok: true });
      const reopened = await getEnquiry(admin, orgA, id1);
      expect(reopened).toMatchObject({ status: "open", lost_reason: null, closed_at: null });
      expect(await setStatus(admin, actor, id1, "won")).toEqual({ ok: true });
      expect(await setStatus(admin, actor, id1, "open")).toEqual({ ok: true });
    });

    it("updates details, custom fields and assignment with notifications", async () => {
      await sql(
        "insert into public.custom_fields (org_id, entity, key, label, type) values ($1, 'enquiry', 'vip', 'VIP', 'boolean')",
        [orgA],
      );
      expect(
        await updateEnquiry(admin, actor, id1, {
          title: "Knee pain consult (follow-up)",
          est_value: 400,
          custom: { vip: true },
        }),
      ).toEqual({ ok: true });
      expect(await updateEnquiry(admin, actor, id1, { custom: { vip: "maybe" } })).toMatchObject({
        ok: false,
      });
      expect(await updateEnquiry(admin, actor, id1, { assignee_id: bea })).toEqual({ ok: true });
      const row = await getEnquiry(admin, orgA, id1);
      expect(row).toMatchObject({
        title: "Knee pain consult (follow-up)",
        est_value: 400,
        assignee_id: bea,
        custom: { vip: true },
      });
      const notes = await sql<{ title: string }>(
        "select title from public.notifications where user_id = $1 and type = 'enquiry.assigned'",
        [bea],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toMatch(/^Enquiry #1 was assigned to you$/);
      expect(
        await updateEnquiry(admin, actor, id1, {
          location_id: "00000000-0000-4000-8000-000000000000",
        }),
      ).toMatchObject({ ok: false });
      const mine = await listEnquiries(
        admin,
        { orgId: orgA, userId: bea },
        f({ assignees: ["me"] }),
        { page: 0, pageSize: 10 },
      );
      expect(mine.rows.map((r) => r.id)).toEqual([id1]);
      const none = await listEnquiries(admin, actor, f({ assignees: ["unassigned"] }), {
        page: 0,
        pageSize: 10,
      });
      expect(none.rows.map((r) => r.id)).toEqual([id2]);
    });

    it("assigns new enquiries by the org rule", async () => {
      await sql(
        "update public.orgs set settings = jsonb_build_object('enquiries', jsonb_build_object('assignment', jsonb_build_object('mode', 'creator'))) where id = $1",
        [orgA],
      );
      const a = await createEnquiry(admin, actor, { contact_id: contact1, pipeline_id: reception });
      expect(a.ok && (await getEnquiry(admin, orgA, a.id))?.assignee_id).toBe(alice);

      await sql("update public.pipelines set default_team_id = $2 where id = $1", [
        reception,
        team,
      ]);
      await sql(
        "update public.orgs set settings = jsonb_build_object('enquiries', jsonb_build_object('assignment', jsonb_build_object('mode', 'round_robin'))) where id = $1",
        [orgA],
      );
      await sql("update public.memberships set presence = 'online' where user_id = $1", [bea]);
      const b = await createEnquiry(admin, actor, { contact_id: contact1, pipeline_id: reception });
      expect(b.ok && (await getEnquiry(admin, orgA, b.id))?.assignee_id).toBe(bea);

      await sql("update public.orgs set settings = '{}'::jsonb where id = $1", [orgA]);
      const c2 = await createEnquiry(admin, actor, {
        contact_id: contact1,
        pipeline_id: reception,
      });
      expect(c2.ok && (await getEnquiry(admin, orgA, c2.id))?.assignee_id).toBeNull();
    });

    it("applies bulk changes and reports failures", async () => {
      const ids = (
        await listEnquiries(admin, actor, f({ scope: "all" }), { page: 0, pageSize: 50 })
      ).rows.map((r) => r.id);
      const res = await bulkUpdate(admin, actor, [id1, id2], {
        status: "lost",
        reason: "Bulk disqualify test",
      });
      expect(res).toMatchObject({ ok: true, updated: 2, failed: 0 });
      const res2 = await bulkUpdate(admin, actor, [id1, id2], { stage_id: receptionStages[2] });
      // id2 lives in the pharmacy pipeline, so its move is refused while id1's succeeds.
      expect(res2).toMatchObject({
        ok: true,
        updated: 1,
        failed: 1,
        firstError: "That stage is not in this pipeline.",
      });
      expect(ids.length).toBeGreaterThanOrEqual(2);
    });

    it("lists a contact's enquiries and exports rows with custom fields", async () => {
      const mine = await enquiriesForContact(admin, orgA, contact1);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.every((r) => r.contact_id === contact1)).toBe(true);
      const exp = await exportRows(admin, actor, f({ scope: "all", pipeline_id: reception }));
      expect(exp.truncated).toBe(false);
      expect(exp.customLabels).toEqual([{ key: "vip", label: "VIP" }]);
      const first = exp.rows.find((r) => r.number === 1)!;
      expect(first).toMatchObject({
        patient: "Sara Example",
        pipeline: "Reception",
        status: "lost",
        reason: "Bulk disqualify test",
      });
      expect(first.custom).toEqual({ vip: "Yes" });
      expect(await enquiriesForContact(admin, orgB, contact1)).toEqual([]);
    });

    it("deletes enquiries only inside the org", async () => {
      expect(await deleteEnquiries(admin, { orgId: orgB, userId: bob }, [id1])).toEqual({
        ok: true,
        deleted: 0,
      });
      expect(await deleteEnquiries(admin, actor, [id1, id2])).toEqual({ ok: true, deleted: 2 });
      expect(await getEnquiry(admin, orgA, id1)).toBeNull();
      const events = await sql("select 1 from public.timeline_events where enquiry_id = $1", [id1]);
      expect(events).toHaveLength(0);
    });
  },
);
