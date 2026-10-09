/**
 * Settings → Enquiries server actions: the rules around pipelines, stages and settings, run against
 * a real Postgres through PostgREST. The session is stubbed (requirePerm returns a fixed member);
 * everything else is real. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL, TEST_SERVICE_JWT.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEnquiry,
  ensureDefaultPipelines,
  loadPipelines,
  orgEnquirySettings,
} from "@/lib/enquiries/service";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const ready = !!TEST_DATABASE_URL && !!POSTGREST_URL && !!SERVICE_JWT;

const session = { orgId: "", userId: "" };
const perms: string[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requirePerm: async (perm: string) => {
    if (!perms.includes(perm) && !perms.includes("*")) throw new Error(`forbidden: ${perm}`);
    return { ...session };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    createClient<Database>(
      process.env.TEST_POSTGREST_URL ?? "http://127.0.0.1:1",
      process.env.TEST_SERVICE_JWT ?? "x",
      {
        auth: { persistSession: false },
      },
    ),
}));

describe.skipIf(!ready)("enquiry settings actions", () => {
  let c: Client;
  let admin: AdminClient;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;
  let contact: string;
  let actions: typeof import("@/app/(app)/settings/enquiries/actions");

  async function sql<T = unknown>(q: string, params: unknown[] = []): Promise<T[]> {
    await c.query("set role service_role");
    try {
      return (await c.query(q, params)).rows as T[];
    } finally {
      await c.query("reset role");
    }
  }

  beforeAll(async () => {
    actions = await import("@/app/(app)/settings/enquiries/actions");
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-s@example.test");
    bob = await createAuthUser(c, "bob-s@example.test");
    orgA = await createOrg(c, "Org A", "org-a-s", alice);
    orgB = await createOrg(c, "Org B", "org-b-s", bob);
    contact = (
      await sql<{ id: string }>(
        "insert into public.contacts (org_id, first_name) values ($1, 'Sara') returning id",
        [orgA],
      )
    )[0].id;
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    });
    session.orgId = orgA;
    session.userId = alice;
    perms.push("settings.manage");
    await ensureDefaultPipelines(admin, orgA);
  });

  afterAll(async () => {
    await c?.end();
  });

  it("refuses callers without settings.manage", async () => {
    perms.length = 0;
    await expect(actions.saveEnquirySettings({})).rejects.toThrow(/forbidden/);
    await expect(
      actions.createPipeline({ name: "x", default_team_id: null, card_fields: [] }),
    ).rejects.toThrow(/forbidden/);
    await expect(actions.deleteStage("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      /forbidden/,
    );
    perms.push("settings.manage");
  });

  it("saves settings, keeps other sections and audits the change", async () => {
    await sql(
      "update public.orgs set settings = jsonb_build_object('inbox', jsonb_build_object('x', 1)) where id = $1",
      [orgA],
    );
    expect(
      await actions.saveEnquirySettings({ sla_hours: 4, assignment: { mode: "creator" } }),
    ).toMatchObject({ ok: true });
    const s = await orgEnquirySettings(admin, orgA);
    expect(s).toMatchObject({ sla_hours: 4, assignment: { mode: "creator" } });
    expect(s.notifications.on_assigned).toBe(true);
    const [{ settings }] = await sql<{ settings: Record<string, unknown> }>(
      "select settings from public.orgs where id = $1",
      [orgA],
    );
    expect(settings.inbox).toEqual({ x: 1 });
    expect(await actions.saveEnquirySettings({ sla_hours: 3 })).toMatchObject({ ok: false });
    expect(await actions.saveEnquirySettings({ assignment: { mode: "everyone" } })).toMatchObject({
      ok: false,
    });
    const audit = await sql(
      "select 1 from public.audit_log where org_id = $1 and action = 'enquiry.settings_updated'",
      [orgA],
    );
    expect(audit).toHaveLength(1);
  });

  it("creates, renames and orders pipelines", async () => {
    const created = await actions.createPipeline({
      name: "Billing queue",
      default_team_id: null,
      card_fields: ["phone"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    expect(
      await actions.createPipeline({
        name: "Billing queue",
        default_team_id: null,
        card_fields: [],
      }),
    ).toEqual({
      ok: false,
      error: "A pipeline with that name already exists.",
    });
    expect(
      await actions.createPipeline({
        name: "x",
        default_team_id: "00000000-0000-4000-8000-000000000000",
        card_fields: [],
      }),
    ).toEqual({
      ok: false,
      error: "That team does not exist.",
    });
    expect(
      await actions.updatePipeline(created.id, {
        name: "Billing",
        default_team_id: null,
        card_fields: ["phone", "source"],
      }),
    ).toEqual({ ok: true });
    const list = await loadPipelines(admin, orgA);
    const billing = list.find((p) => p.id === created.id)!;
    expect(billing).toMatchObject({ name: "Billing", card_fields: ["phone", "source"] });
    expect(billing.stages.map((s) => s.name)).toEqual(["New", "In progress"]);
    expect(
      await actions.updatePipeline(created.id, {
        name: "Reception",
        default_team_id: null,
        card_fields: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await actions.updatePipeline(created.id, {
        name: "",
        default_team_id: null,
        card_fields: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await actions.updatePipeline(created.id, {
        name: "x",
        default_team_id: null,
        card_fields: ["password"] as never,
      }),
    ).toMatchObject({ ok: false });

    const ids = list.map((p) => p.id);
    expect(await actions.reorderPipelines([...ids].reverse())).toEqual({ ok: true });
    expect((await loadPipelines(admin, orgA))[0].id).toBe(ids.at(-1));
    expect(await actions.reorderPipelines(ids.slice(1))).toMatchObject({ ok: false });
    expect(
      await actions.reorderPipelines([...ids.slice(1), "00000000-0000-4000-8000-000000000000"]),
    ).toMatchObject({ ok: false });
  });

  it("manages stages: add, rename, colour, reorder and guarded delete", async () => {
    const [p] = (await loadPipelines(admin, orgA)).filter((x) => x.name === "Reception");
    const added = await actions.createStage(p.id, { name: "Booked", color: "green" });
    expect(added.ok).toBe(true);
    expect(await actions.createStage(p.id, { name: "Booked", color: "green" })).toEqual({
      ok: false,
      error: "This pipeline already has a stage with that name.",
    });
    expect(
      await actions.createStage(p.id, { name: "Nope", color: "plaid" as never }),
    ).toMatchObject({ ok: false });
    if (!added.ok) throw new Error("add failed");
    expect(await actions.updateStage(added.id, { name: "Booked in", color: "teal" })).toEqual({
      ok: true,
    });
    let stages = (await loadPipelines(admin, orgA)).find((x) => x.id === p.id)!.stages;
    expect(stages.map((s) => [s.name, s.color])).toEqual([
      ["New", "slate"],
      ["In progress", "blue"],
      ["Follow-up", "amber"],
      ["Booked in", "teal"],
    ]);
    const order = stages.map((s) => s.id);
    expect(await actions.reorderStages(p.id, [order[3], ...order.slice(0, 3)])).toEqual({
      ok: true,
    });
    stages = (await loadPipelines(admin, orgA)).find((x) => x.id === p.id)!.stages;
    expect(stages[0].name).toBe("Booked in");
    expect(await actions.reorderStages(p.id, order.slice(0, 2))).toMatchObject({ ok: false });

    // A stage with enquiries cannot be removed; an empty one can.
    const used = stages.find((s) => s.name === "New")!;
    const made = await createEnquiry(
      admin,
      { orgId: orgA, userId: alice },
      { contact_id: contact, pipeline_id: p.id, stage_id: used.id },
    );
    expect(made.ok).toBe(true);
    expect(await actions.deleteStage(used.id)).toEqual({
      ok: false,
      error: "1 enquiries are in this stage. Move them first.",
    });
    expect(await actions.deleteStage(added.id)).toEqual({ ok: true });
    expect((await loadPipelines(admin, orgA)).find((x) => x.id === p.id)!.stages).toHaveLength(3);
  });

  it("keeps the last stage and refuses archiving busy or last pipelines", async () => {
    const list = await loadPipelines(admin, orgA);
    const billing = list.find((p) => p.name === "Billing")!;
    for (const s of billing.stages.slice(1))
      expect(await actions.deleteStage(s.id)).toEqual({ ok: true });
    expect(await actions.deleteStage(billing.stages[0].id)).toEqual({
      ok: false,
      error: "A pipeline needs at least one stage.",
    });

    const reception = list.find((p) => p.name === "Reception")!;
    expect(await actions.archivePipeline(reception.id, true)).toEqual({
      ok: false,
      error: "Move or close its 1 open enquiries first.",
    });
    expect(await actions.archivePipeline(billing.id, true)).toEqual({ ok: true });
    expect((await loadPipelines(admin, orgA)).find((p) => p.id === billing.id)?.archived).toBe(
      true,
    );
    expect(await actions.archivePipeline(billing.id, false)).toEqual({ ok: true });
    // Archive everything except one: the last active pipeline is protected.
    const rest = (await loadPipelines(admin, orgA)).filter(
      (p) => p.id !== reception.id && !p.archived,
    );
    for (const p of rest) expect(await actions.archivePipeline(p.id, true)).toEqual({ ok: true });
    expect(await actions.archivePipeline(reception.id, true)).toMatchObject({ ok: false });
  });

  it("never touches another org's configuration", async () => {
    await ensureDefaultPipelines(admin, orgB);
    const theirs = (await loadPipelines(admin, orgB))[0];
    expect(
      await actions.updatePipeline(theirs.id, {
        name: "Hijacked",
        default_team_id: null,
        card_fields: [],
      }),
    ).toEqual({ ok: false, error: "Pipeline not found." });
    expect(await actions.createStage(theirs.id, { name: "Evil", color: "red" })).toEqual({
      ok: false,
      error: "Pipeline not found.",
    });
    expect(await actions.updateStage(theirs.stages[0].id, { name: "Evil", color: "red" })).toEqual({
      ok: false,
      error: "Stage not found.",
    });
    expect(await actions.deleteStage(theirs.stages[0].id)).toEqual({
      ok: false,
      error: "Stage not found.",
    });
    expect(await actions.archivePipeline(theirs.id, true)).toMatchObject({ ok: false });
    expect(
      await actions.reorderStages(
        theirs.id,
        theirs.stages.map((s) => s.id),
      ),
    ).toMatchObject({ ok: false });
    expect((await loadPipelines(admin, orgB))[0].name).toBe(theirs.name);
    expect(orgB).not.toBe(orgA);
  });
});
