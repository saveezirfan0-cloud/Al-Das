/**
 * Exercises the supabase-js code paths (writer, matcher, RPC calls) through a
 * real PostgREST in front of the test database. Runs only when
 * TEST_POSTGREST_URL and TEST_SERVICE_JWT are set (see supabase/test/README.md).
 * Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, cond } from "@/lib/filters/ast";
import {
  findExternalRef,
  matchContact,
  queueSyncReview,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";
import type { PreparedContact } from "@/lib/contacts/import";
import { countContacts, matchingContactIds, queryContacts } from "@/lib/contacts/query";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

function prepared(p: Partial<PreparedContact>): PreparedContact {
  return {
    first_name: "",
    last_name: "",
    phone_e164: null,
    alternate_phones: [],
    email: null,
    gender: null,
    nationality: null,
    country: null,
    language: null,
    dob: null,
    label: null,
    external_id: null,
    promotions_opt_in: null,
    stop_marketing: null,
    tags: [],
    source: null,
    note: null,
    custom: {},
    ...p,
  };
}

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "supabase-js paths through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let user: string;
    const registry = buildContactFieldRegistry({
      customFields: [
        { key: "plan", label: "Plan", type: "select", options: [{ value: "axa", label: "AXA" }] },
      ],
    });
    const tagIds = new Map<string, string>();

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "writer@example.test");
      org = await createOrg(c, "Org W", "org-w", user);
      await c.query("set role service_role");
      await c.query(
        "insert into public.custom_fields (org_id, key, label, type, options) values ($1, 'plan', 'Plan', 'select', '[{\"value\":\"axa\",\"label\":\"AXA\"}]')",
        [org],
      );
      await c.query("reset role");
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      });
      // PostgREST caches the schema; make sure it has seen the custom_fields row's table (no DDL happened, so fine).
    });

    afterAll(async () => {
      await c?.end();
    });

    const customFields = [
      {
        key: "plan",
        label: "Plan",
        type: "select" as const,
        options: [{ value: "axa", label: "AXA" }],
        required: false,
      },
    ];
    let amina: string;

    it("creates a contact with phones, tags, custom values and a note", async () => {
      const res = await writePreparedContact(admin, {
        orgId: org,
        existingId: null,
        contact: prepared({
          first_name: "Amina",
          last_name: "Test",
          phone_e164: "+971500000001",
          alternate_phones: ["+971500000011"],
          email: "amina@example.test",
          dob: "1990-10-10",
          external_id: "PIN-1",
          tags: ["VIP", "Derma"],
          custom: { plan: "AXA" },
          note: "Imported note",
          promotions_opt_in: true,
        }),
        defaultSource: "import_sanoflow",
        customFields,
        tagIds,
        actorId: user,
        batch: "b1",
      });
      expect(res).toMatchObject({ ok: true, created: true });
      if (!res.ok) return;
      amina = res.id;
      const { data } = await admin
        .from("contacts")
        .select("*, contact_tags(tags(name)), contact_phones(phone_e164)")
        .eq("id", amina)
        .single();
      expect(data?.custom).toEqual({ plan: "axa" });
      expect(data?.source).toBe("import_sanoflow");
      expect(data?.promotions_opt_in).toBe(true);
      expect(data?.contact_tags?.map((t) => t.tags?.name).sort()).toEqual(["Derma", "VIP"]);
      expect(data?.contact_phones?.map((p) => p.phone_e164)).toEqual(["+971500000011"]);
      expect(tagIds.size).toBe(2);
      const { data: events } = await admin
        .from("timeline_events")
        .select("type")
        .eq("contact_id", amina);
      expect(events?.map((e) => e.type).sort()).toEqual(["import.created", "note"]);
    });

    it("matches by external id, phone (incl. alternates) and name + dob", async () => {
      expect(await matchContact(admin, org, { externalId: "PIN-1" })).toMatchObject({
        kind: "match",
        id: amina,
        on: "external_id",
      });
      expect(await matchContact(admin, org, { phone: "+971500000011" })).toMatchObject({
        kind: "match",
        id: amina,
        on: "phone",
      });
      expect(
        await matchContact(admin, org, { fullName: "amina test", dob: "1990-10-10" }),
      ).toMatchObject({ kind: "match", id: amina, on: "name_dob" });
      expect(await matchContact(admin, org, { phone: "+971500000099" })).toEqual({ kind: "none" });
    });

    it("updates a matched contact without clearing data and never clears an opt-out", async () => {
      await admin.from("contacts").update({ stop_marketing: true }).eq("id", amina);
      const res = await writePreparedContact(admin, {
        orgId: org,
        existingId: amina,
        existingCustom: { plan: "axa", other: 1 },
        contact: prepared({
          first_name: "Amina",
          last_name: "",
          phone_e164: "+971500000001",
          nationality: "AE",
          stop_marketing: false,
          tags: ["vip"],
        }),
        defaultSource: "import_csv",
        customFields,
        tagIds,
        actorId: null,
        batch: "b2",
      });
      expect(res).toMatchObject({ ok: true, created: false });
      const { data } = await admin
        .from("contacts")
        .select("last_name, nationality, stop_marketing, custom")
        .eq("id", amina)
        .single();
      expect(data).toEqual({
        last_name: "Test",
        nationality: "AE",
        stop_marketing: true,
        custom: { plan: "axa", other: 1 },
      });
    });

    it("reports ambiguous matches instead of guessing", async () => {
      await admin
        .from("contacts")
        .insert({
          org_id: org,
          first_name: "Amina",
          last_name: "Test",
          dob: "1990-10-10",
          phone_e164: "+971500000002",
        });
      const m = await matchContact(admin, org, { fullName: "Amina Test", dob: "1990-10-10" });
      expect(m.kind).toBe("ambiguous");
      if (m.kind === "ambiguous") {
        await queueSyncReview(admin, {
          orgId: org,
          source: "airtable",
          entity: "t",
          externalId: "rec1",
          reason: "multiple_name_dob",
          candidates: m.candidates,
        });
        const { data } = await admin
          .from("sync_reviews")
          .select("status, candidates")
          .eq("org_id", org)
          .single();
        expect(data?.status).toBe("open");
        expect((data?.candidates as unknown[]).length).toBe(2);
      }
    });

    it("keeps external refs idempotent", async () => {
      await upsertExternalRef(admin, {
        orgId: org,
        source: "sanoflow",
        entity: "contact",
        externalId: "sf-1",
        localTable: "contacts",
        localId: amina,
        meta: { a: 1 },
      });
      await upsertExternalRef(admin, {
        orgId: org,
        source: "sanoflow",
        entity: "contact",
        externalId: "sf-1",
        localTable: "contacts",
        localId: amina,
        meta: { a: 2 },
      });
      expect(
        await findExternalRef(admin, {
          orgId: org,
          source: "sanoflow",
          entity: "contact",
          externalId: "sf-1",
        }),
      ).toEqual({ localId: amina, meta: { a: 2 } });
      const { count } = await admin
        .from("external_refs")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org);
      expect(count).toBe(1);
    });

    it("queries, counts and lists ids through the RPCs", async () => {
      const page = await queryContacts(admin, {
        orgId: org,
        registry,
        filter: { include: and(cond("custom.plan", "eq", "axa")) },
        search: "amina",
        sort: [{ field: "full_name", dir: "asc" }],
        pageSize: 10,
        timezone: "Asia/Dubai",
      });
      expect(page.total).toBe(1);
      expect(page.rows[0].id).toBe(amina);
      expect(page.rows[0].tags.map((t) => t.name).sort()).toEqual(["Derma", "VIP"]);
      expect(
        await countContacts(admin, org, registry, {
          include: and(cond("tags", "has_any", [tagIds.get("vip")!])),
        }),
      ).toBe(1);
      const all = await matchingContactIds(admin, org, registry, null, null);
      expect(all.length).toBe(2);
      expect(all).toContain(amina);
      const none = await queryContacts(admin, { orgId: org, registry, search: "+97150000009" });
      expect(none.total).toBe(0);
    });

    it("merges through the RPC and reads duplicate candidates", async () => {
      const { data: dupes } = await admin.rpc("contact_duplicate_candidates", {
        p_org_id: org,
        p_limit: 10,
      });
      expect(dupes?.map((d) => d.reason)).toEqual(["name_dob"]);
      const other = dupes![0].a_id === amina ? dupes![0].b_id : dupes![0].a_id;
      const { error } = await admin.rpc("merge_contacts", {
        p_org_id: org,
        p_primary_id: amina,
        p_secondary_id: other,
        p_fields: { label: "merged" },
        p_user_id: user,
      });
      expect(error).toBeNull();
      const { data } = await admin
        .from("contacts")
        .select("label, deleted_at")
        .eq("id", other)
        .single();
      expect(data?.deleted_at).not.toBeNull();
      const { data: p } = await admin
        .from("contacts")
        .select("label, contact_phones(phone_e164)")
        .eq("id", amina)
        .single();
      expect(p?.label).toBe("merged");
      expect(p?.contact_phones?.map((x) => x.phone_e164).sort()).toEqual([
        "+971500000002",
        "+971500000011",
      ]);
    });
  },
);
