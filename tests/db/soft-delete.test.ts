/**
 * Soft delete with a restore window (docs/35_SOFT_DELETE_NOTES.md): the bin (deleted_items), the SQL functions
 * soft_delete_records / restore_deleted_record / purge_deleted_records, the default-read policies and the erasure
 * trigger. Synthetic data only. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type Ids = {
  contact: string;
  contact2: string;
  enquiry: string;
  taskOnEnquiry: string;
  task: string;
  entry: string;
  appointment: string;
  contactB: string;
  taskB: string;
};

describe.skipIf(!TEST_DATABASE_URL)("soft delete and restore window", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;
  let ids: Ids;

  const one = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ id: string }>(sql, params)).rows[0].id;

  const softDelete = (org: string, entity: string, list: string[], actor: string | null = null) =>
    asServiceRole(c, async () =>
      (
        await c.query<{ r: string[] }>("select public.soft_delete_records($1, $2, $3::uuid[], $4) as r", [
          org,
          entity,
          list,
          actor,
        ])
      ).rows[0].r,
    );
  const restore = (org: string, entity: string, id: string, actor: string | null = null) =>
    asServiceRole(c, async () =>
      (
        await c.query<{ r: string }>("select public.restore_deleted_record($1, $2, $3, $4) as r", [
          org,
          entity,
          id,
          actor,
        ])
      ).rows[0].r,
    );
  const purge = () =>
    asServiceRole(c, async () => (await c.query("select public.purge_deleted_records() as r")).rows[0].r);
  const ageBinRow = (entity: string, id: string, days: number) =>
    asServiceRole(c, () =>
      c.query(
        "update public.deleted_items set deleted_at = now() - make_interval(days => $3) where entity = $1 and record_id = $2",
        [entity, id, days],
      ),
    );

  beforeAll(async () => {
    c = await connect();
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  beforeEach(async () => {
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const contact = await one(
        "insert into public.contacts (org_id, first_name, last_name, phone_e164, wa_bsuid, external_id) values ($1, 'Layla', 'Demo-01', '+447700900101', 'bsuid-demo-01', 'PIN-DEMO-01') returning id",
        [orgA],
      );
      const contact2 = await one(
        "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Omar', 'Demo-02', '+447700900102') returning id",
        [orgA],
      );
      const pipeline = await one(
        "insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true) returning id",
        [orgA],
      );
      const stage = await one(
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0) returning id",
        [orgA, pipeline],
      );
      const enquiry = await one(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'Synthetic enquiry') returning id",
        [orgA, pipeline, stage, contact],
      );
      await c.query(
        "insert into public.timeline_events (org_id, contact_id, enquiry_id, type) values ($1, $2, $3, 'enquiry.created')",
        [orgA, contact, enquiry],
      );
      const taskOnEnquiry = await one(
        "insert into public.tasks (org_id, subject, due_at, contact_id, enquiry_id) values ($1, 'Call back', now() + interval '1 day', $2, $3) returning id",
        [orgA, contact, enquiry],
      );
      const task = await one(
        "insert into public.tasks (org_id, subject, due_at) values ($1, 'Order supplies', now() + interval '1 day') returning id",
        [orgA],
      );
      const entry = await one(
        "insert into public.website_entry_points (org_id, section, source_key) values ($1, '01. General', 'Synthetic source') returning id",
        [orgA],
      );
      await c.query("select public.seed_portal_objects($1)", [orgA]);
      const tag = await one(
        "insert into public.tags (org_id, name, scope) values ($1, 'Entry tag', 'portal') returning id",
        [orgA],
      );
      await c.query(
        "insert into public.portal_record_tags (org_id, object_key, record_id, tag_id) values ($1, 'website_entry_points', $2, $3)",
        [orgA, entry, tag],
      );
      const appointment = await one(
        "insert into public.appointments (org_id, contact_id, starts_at, ends_at) values ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes') returning id",
        [orgA, contact2],
      );
      const contactB = await one(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Sara', '+447700900103') returning id",
        [orgB],
      );
      const taskB = await one(
        "insert into public.tasks (org_id, subject, due_at) values ($1, 'Org B task', now() + interval '1 day') returning id",
        [orgB],
      );
      ids = { contact, contact2, enquiry, taskOnEnquiry, task, entry, appointment, contactB, taskB };
    });
  });

  it("moves records into the bin, frees the contact's identifiers and skips other orgs' ids", async () => {
    expect(await softDelete(orgA, "contact", [ids.contact, ids.contactB], alice)).toEqual([ids.contact]);
    expect(await softDelete(orgA, "task", [ids.task, ids.taskB], alice)).toEqual([ids.task]);
    expect(await softDelete(orgA, "task", [ids.task], alice)).toEqual([]); // already in the bin
    await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "select deleted_at is not null as deleted, phone_e164, wa_bsuid, external_id from public.contacts where id = $1",
        [ids.contact],
      );
      expect(rows[0]).toEqual({ deleted: true, phone_e164: null, wa_bsuid: null, external_id: null });
      const bin = await c.query(
        "select entity, deleted_by, restore_data from public.deleted_items where org_id = $1 order by entity",
        [orgA],
      );
      expect(bin.rows).toEqual([
        {
          entity: "contact",
          deleted_by: alice,
          restore_data: { phone_e164: "+447700900101", wa_bsuid: "bsuid-demo-01", external_id: "PIN-DEMO-01" },
        },
        { entity: "task", deleted_by: alice, restore_data: {} },
      ]);
      expect(await count(c, "select 1 from public.contacts where id = $1 and deleted_at is null", [ids.contactB])).toBe(1);
      expect(await count(c, "select 1 from public.tasks where id = $1 and deleted_at is null", [ids.taskB])).toBe(1);
    });
  });

  it("hides deleted rows from normal reads and keeps the bin service-only", async () => {
    await softDelete(orgA, "task", [ids.task], alice);
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await softDelete(orgA, "website_entry_point", [ids.entry], alice);
    await softDelete(orgA, "contact", [ids.contact2], alice);
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.tasks where id = $1", [ids.task])).toBe(0);
      expect(await count(c, "select 1 from public.tasks where id = $1", [ids.taskOnEnquiry])).toBe(1);
      expect(await count(c, "select 1 from public.enquiries where id = $1", [ids.enquiry])).toBe(0);
      expect(await count(c, "select 1 from public.website_entry_points where id = $1", [ids.entry])).toBe(0);
      expect(await count(c, "select 1 from public.deleted_items")).toBe(0);
      // A browser can neither edit a row in the bin nor move a row into it around the bin.
      const u = await c.query("update public.tasks set subject = 'x' where id = $1", [ids.task]);
      expect(u.rowCount).toBe(0);
      const err = await c
        .query("update public.tasks set deleted_at = now() where id = $1", [ids.taskOnEnquiry])
        .then(() => null, (e: { code?: string }) => e);
      expect(err?.code).toBe("42501");
    });
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.contacts_search($1, 'true', '[]'::jsonb, 'c.created_at', 100, 0)",
        [orgA],
      );
      expect(rows.map((r) => r.id)).toEqual([ids.contact]);
    });
  });

  it("restores within the window and puts the contact's identifiers back", async () => {
    await softDelete(orgA, "contact", [ids.contact], alice);
    expect(await restore(orgA, "contact", ids.contact, alice)).toBe("restored");
    await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "select deleted_at, phone_e164, wa_bsuid, external_id from public.contacts where id = $1",
        [ids.contact],
      );
      expect(rows[0]).toEqual({
        deleted_at: null,
        phone_e164: "+447700900101",
        wa_bsuid: "bsuid-demo-01",
        external_id: "PIN-DEMO-01",
      });
      expect(await count(c, "select 1 from public.deleted_items")).toBe(0);
    });
    expect(await restore(orgA, "contact", ids.contact, alice)).toBe("not_found");
  });

  it("refuses a child while its contact is in the bin, and restores it after the contact", async () => {
    await softDelete(orgA, "contact", [ids.contact], alice);
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await softDelete(orgA, "task", [ids.taskOnEnquiry], alice);
    expect(await restore(orgA, "enquiry", ids.enquiry)).toBe("parent_deleted");
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("parent_deleted");
    expect(await restore(orgA, "contact", ids.contact)).toBe("restored");
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("parent_deleted"); // its enquiry is still in the bin
    expect(await restore(orgA, "enquiry", ids.enquiry)).toBe("restored");
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("restored");
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.enquiries where id = $1", [ids.enquiry])).toBe(1);
      expect(await count(c, "select 1 from public.tasks where id = $1", [ids.taskOnEnquiry])).toBe(1);
    });
  });

  it("checks the parent row itself: deleted before this release, already purged, erased or merged", async () => {
    // A contact deleted before this release has deleted_at but no bin row.
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await softDelete(orgA, "task", [ids.taskOnEnquiry], alice);
    await asServiceRole(c, () => c.query("update public.contacts set deleted_at = now() where id = $1", [ids.contact]));
    expect(await restore(orgA, "enquiry", ids.enquiry)).toBe("parent_deleted");
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("parent_deleted");
    await asServiceRole(c, () => c.query("update public.contacts set deleted_at = null where id = $1", [ids.contact]));
    expect(await restore(orgA, "enquiry", ids.enquiry)).toBe("restored");
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("restored");

    // A task whose enquiry was deleted before this release (no bin row for the enquiry).
    await softDelete(orgA, "task", [ids.taskOnEnquiry], alice);
    await asServiceRole(c, () => c.query("update public.enquiries set deleted_at = now() where id = $1", [ids.enquiry]));
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("parent_deleted");
    await asServiceRole(c, () => c.query("update public.enquiries set deleted_at = null where id = $1", [ids.enquiry]));
    expect(await restore(orgA, "task", ids.taskOnEnquiry)).toBe("restored");
  });

  it("refuses a child whose contact's bin row was purged first", async () => {
    await softDelete(orgA, "contact", [ids.contact], alice);
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await ageBinRow("contact", ids.contact, 31);
    await purge();
    expect(await restore(orgA, "contact", ids.contact)).toBe("not_found");
    expect(await restore(orgA, "enquiry", ids.enquiry)).toBe("parent_deleted");
  });

  it("refuses a child of an erased or a merged patient", async () => {
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await asServiceRole(c, () => c.query("select public.erase_contact($1, $2, $3)", [orgA, ids.contact, alice]));
    expect(await restore(orgA, "enquiry", ids.enquiry)).toBe("parent_deleted");

    const task = await asServiceRole(c, () =>
      one(
        "insert into public.tasks (org_id, subject, due_at, contact_id) values ($1, 'Merged patient task', now(), $2) returning id",
        [orgA, ids.contact2],
      ),
    );
    await softDelete(orgA, "task", [task], alice);
    const survivor = await asServiceRole(c, () =>
      one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Survivor', '+447700900104') returning id", [orgA]),
    );
    // A task still pointing at a merged contact (merged_into_id set; the row is hidden).
    await asServiceRole(c, () =>
      c.query("update public.contacts set merged_into_id = $2 where id = $1", [ids.contact2, survivor]),
    );
    expect(await restore(orgA, "task", task)).toBe("parent_deleted");
  });

  it("lets no browser hard-delete contacts, enquiries, tasks or website entry points", async () => {
    await asUser(c, alice, async () => {
      for (const [table, id] of [
        ["contacts", ids.contact],
        ["enquiries", ids.enquiry],
        ["tasks", ids.task],
        ["website_entry_points", ids.entry],
      ] as const) {
        const r = await c.query(`delete from public.${table} where id = $1`, [id]);
        expect(r.rowCount, table).toBe(0);
      }
    });
    await asServiceRole(c, async () => {
      expect(await count(c, "select 1 from public.tasks where id = $1", [ids.task])).toBe(1);
      expect(await count(c, "select 1 from public.contacts where id = $1", [ids.contact])).toBe(1);
    });
  });

  it("lists the bin per member: only the kinds asked for, enquiries in their view, paged newest first", async () => {
    const carol = await createAuthUser(c, "carol@example.test");
    await asServiceRole(c, () =>
      c.query(
        "insert into public.memberships (org_id, user_id, role_id, enquiry_scope) select $1, $2, id, 'own' from public.roles where org_id = $1 and name = 'Agent'",
        [orgA, carol],
      ),
    );
    await softDelete(orgA, "task", [ids.task], alice);
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await softDelete(orgA, "website_entry_point", [ids.entry], alice);
    await softDelete(orgA, "contact", [ids.contact2], alice);
    await ageBinRow("task", ids.task, 3);
    await ageBinRow("enquiry", ids.enquiry, 2);
    await ageBinRow("website_entry_point", ids.entry, 1);
    const list = (user: string, kinds: string[], limit = 100, offset = 0) =>
      asServiceRole(c, async () =>
        (
          await c.query<{ entity: string; record_id: string; title: string }>(
            "select entity, record_id, title from public.list_deleted_items($1, $2, $3::text[], $4, $5)",
            [orgA, user, kinds, limit, offset],
          )
        ).rows,
      );
    const all = await list(alice, ["contact", "enquiry", "task", "website_entry_point"]);
    expect(all.map((r) => r.entity)).toEqual(["contact", "website_entry_point", "enquiry", "task"]);
    expect(all.map((r) => r.title)).toEqual([
      "Omar Demo-02",
      "01. General: Synthetic source",
      expect.stringMatching(/^#\d+ Synthetic enquiry$/),
      "Order supplies",
    ]);
    expect((await list(alice, ["task"])).map((r) => r.record_id)).toEqual([ids.task]);
    // Carol sees only her own enquiries: this one was created by nobody and is unassigned.
    expect((await list(carol, ["enquiry", "task"])).map((r) => r.entity)).toEqual(["task"]);
    // Paging.
    expect((await list(alice, ["contact", "enquiry", "task", "website_entry_point"], 2, 0)).map((r) => r.entity)).toEqual([
      "contact",
      "website_entry_point",
    ]);
    expect((await list(alice, ["contact", "enquiry", "task", "website_entry_point"], 2, 2)).map((r) => r.entity)).toEqual([
      "enquiry",
      "task",
    ]);
    // Another org sees nothing of it.
    expect(
      await asServiceRole(c, () =>
        count(c, "select 1 from public.list_deleted_items($1, $2, array['task','enquiry','contact','website_entry_point'], 100, 0)", [orgB, bob]),
      ),
    ).toBe(0);
  });

  it("refuses a restore that would clash with a live record", async () => {
    await softDelete(orgA, "contact", [ids.contact], alice);
    // The number was freed, so a new contact may take it.
    await asServiceRole(c, () =>
      c.query("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'New', '+447700900101')", [orgA]),
    );
    expect(await restore(orgA, "contact", ids.contact)).toBe("conflict");

    // One open call task per appointment: a deleted one no longer blocks a new one, and cannot come back over it.
    const callTask = await asServiceRole(c, () =>
      one(
        "insert into public.tasks (org_id, type, subject, due_at, appointment_id) values ($1, 'call', 'Call patient', now(), $2) returning id",
        [orgA, ids.appointment],
      ),
    );
    await softDelete(orgA, "task", [callTask], alice);
    await asServiceRole(c, () =>
      c.query(
        "insert into public.tasks (org_id, type, subject, due_at, appointment_id) values ($1, 'call', 'Call patient again', now(), $2)",
        [orgA, ids.appointment],
      ),
    );
    expect(await restore(orgA, "task", callTask)).toBe("conflict");
  });

  it("follows each org's window for restore: expired past it, allowed with a longer window", async () => {
    await softDelete(orgA, "task", [ids.task], alice);
    await ageBinRow("task", ids.task, 31);
    expect(await restore(orgA, "task", ids.task)).toBe("expired");
    await asServiceRole(c, () =>
      c.query(`update public.orgs set settings = '{"soft_delete": {"restore_window_days": 60}}'::jsonb where id = $1`, [orgA]),
    );
    expect(await restore(orgA, "task", ids.task)).toBe("restored");
  });

  it("isolates orgs: another org can neither restore nor see the item", async () => {
    await softDelete(orgA, "task", [ids.task], alice);
    expect(await restore(orgB, "task", ids.task, bob)).toBe("not_found");
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.deleted_items")).toBe(0);
      expect(await count(c, "select 1 from public.tasks where org_id = $1", [orgA])).toBe(0);
    });
    await asServiceRole(c, async () => {
      expect(await count(c, "select 1 from public.deleted_items where record_id = $1", [ids.task])).toBe(1);
    });
  });

  it("purges only rows past their own org's window and keeps an enquiry's tasks and timeline", async () => {
    await asServiceRole(c, () =>
      c.query(`update public.orgs set settings = '{"soft_delete": {"restore_window_days": 5}}'::jsonb where id = $1`, [orgB]),
    );
    await softDelete(orgA, "task", [ids.task], alice);
    await softDelete(orgA, "enquiry", [ids.enquiry], alice);
    await softDelete(orgA, "website_entry_point", [ids.entry], alice);
    await softDelete(orgA, "contact", [ids.contact2], alice);
    await softDelete(orgB, "task", [ids.taskB], bob);
    await ageBinRow("task", ids.task, 31);
    await ageBinRow("enquiry", ids.enquiry, 31);
    await ageBinRow("website_entry_point", ids.entry, 10); // inside A's 30 days: stays
    await ageBinRow("contact", ids.contact2, 31);
    await ageBinRow("task", ids.taskB, 10); // past B's 5 days: goes

    const r = await purge();
    expect(r).toMatchObject({ orgs: 2, tasks: 2, enquiries: 1, contacts: 1, website_entry_points: 0, more: false });

    await asServiceRole(c, async () => {
      expect(await count(c, "select 1 from public.tasks where id = any ($1)", [[ids.task, ids.taskB]])).toBe(0);
      expect(await count(c, "select 1 from public.enquiries where id = $1", [ids.enquiry])).toBe(0);
      // The enquiry's task and the patient's timeline entry stay, unlinked.
      const t = await c.query("select enquiry_id, deleted_at from public.tasks where id = $1", [ids.taskOnEnquiry]);
      expect(t.rows[0]).toEqual({ enquiry_id: null, deleted_at: null });
      expect(
        await count(c, "select 1 from public.timeline_events where contact_id = $1 and type = 'enquiry.created'", [
          ids.contact,
        ]),
      ).toBe(1);
      // The contact keeps its hidden row; only the restore copy goes.
      expect(await count(c, "select 1 from public.contacts where id = $1 and deleted_at is not null", [ids.contact2])).toBe(1);
      expect(await count(c, "select 1 from public.deleted_items where record_id = $1", [ids.contact2])).toBe(0);
      // The entry point is still restorable, with its tag.
      expect(await count(c, "select 1 from public.deleted_items where record_id = $1", [ids.entry])).toBe(1);
      expect(await count(c, "select 1 from public.portal_record_tags where record_id = $1", [ids.entry])).toBe(1);
      // One audit row per org, counts only.
      const audit = await c.query<{ org_id: string; diff: Record<string, number> }>(
        "select org_id, diff from public.audit_log where action = 'deleted_items.purged' order by org_id = $1 desc",
        [orgA],
      );
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows[0]).toMatchObject({
        org_id: orgA,
        diff: { items: 3, tasks: 1, enquiries: 1, contacts: 1, website_entry_points: 0, window_days: 30 },
      });
      expect(audit.rows[1]).toMatchObject({ org_id: orgB, diff: { items: 1, tasks: 1, window_days: 5 } });
    });
    expect(await restore(orgA, "contact", ids.contact2)).toBe("not_found");

    // Idempotent: a second run finds nothing more to do.
    expect(await purge()).toMatchObject({ orgs: 0, tasks: 0, more: false });

    // Past the window the entry point and its portal tags go.
    await ageBinRow("website_entry_point", ids.entry, 31);
    expect(await purge()).toMatchObject({ website_entry_points: 1 });
    await asServiceRole(c, async () => {
      expect(await count(c, "select 1 from public.website_entry_points where id = $1", [ids.entry])).toBe(0);
      expect(await count(c, "select 1 from public.portal_record_tags where record_id = $1", [ids.entry])).toBe(0);
    });
  });

  it("keeps erasure a real erasure: an erased patient leaves the bin and cannot be restored", async () => {
    await asServiceRole(c, () =>
      c.query("insert into public.contact_phones (org_id, contact_id, phone_e164) values ($1, $2, '+447700900199')", [
        orgA,
        ids.contact,
      ]),
    );
    await softDelete(orgA, "contact", [ids.contact], alice);
    await asServiceRole(c, async () => {
      await c.query("select public.erase_contact($1, $2, $3)", [orgA, ids.contact, alice]);
      const { rows } = await c.query(
        "select first_name, phone_e164, erased_at is not null as erased from public.contacts where id = $1",
        [ids.contact],
      );
      expect(rows[0]).toEqual({ first_name: "Erased", phone_e164: null, erased: true });
      expect(await count(c, "select 1 from public.contact_phones where contact_id = $1", [ids.contact])).toBe(0);
      expect(await count(c, "select 1 from public.timeline_events where contact_id = $1", [ids.contact])).toBe(0);
      expect(await count(c, "select 1 from public.deleted_items where record_id = $1", [ids.contact])).toBe(0);
    });
    expect(await restore(orgA, "contact", ids.contact)).toBe("not_found");
    // Merged or erased contacts never enter the bin.
    expect(await softDelete(orgA, "contact", [ids.contact], alice)).toEqual([]);
  });

  it("exposes the four functions to the service role only", async () => {
    const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any ($1) order by 1`,
      [["list_deleted_items", "purge_deleted_records", "restore_deleted_record", "soft_delete_records"]],
    );
    expect(rows).toEqual([
      { name: "list_deleted_items", anon: false, auth: false, svc: true },
      { name: "purge_deleted_records", anon: false, auth: false, svc: true },
      { name: "restore_deleted_record", anon: false, auth: false, svc: true },
      { name: "soft_delete_records", anon: false, auth: false, svc: true },
    ]);
  });
});
