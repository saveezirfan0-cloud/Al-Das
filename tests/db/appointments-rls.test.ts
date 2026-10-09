/**
 * Phase 6 appointment tables: cross-org isolation, permission-gated writes, org consistency of
 * references, per-org appointment numbers. Runs only with TEST_DATABASE_URL. Fake data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, cond } from "@/lib/filters/ast";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";
import { compileFilter } from "@/lib/filters/to-sql";

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

describe.skipIf(!TEST_DATABASE_URL)("appointments RLS", () => {
  let c: Client;
  let alice: string; // admin A
  let bob: string; // admin B
  let viewer: string; // org A, appointments.view only
  let booker: string; // org A, appointments.view + appointments.manage
  let orgA: string;
  let orgB: string;
  const ids: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    viewer = await createAuthUser(c, "viewer@example.test");
    booker = await createAuthUser(c, "booker@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      for (const [user, name, perms] of [
        [viewer, "Viewer", ["appointments.view", "contacts.view"]],
        [booker, "Booker", ["appointments.view", "appointments.manage", "contacts.view"]],
      ] as const) {
        const roleId = await insert(
          "insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb)",
          [orgA, name, JSON.stringify(perms)],
        );
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id, status) values ($1, $2, $3, 'active')",
          [orgA, user, roleId],
        );
      }
      for (const [tag, org] of [
        ["a", orgA],
        ["b", orgB],
      ] as const) {
        ids[`loc_${tag}`] = await insert(
          "insert into public.locations (org_id, name) values ($1, $2)",
          [org, `Clinic ${tag}`],
        );
        ids[`dept_${tag}`] = await insert(
          "insert into public.departments (org_id, name) values ($1, 'General')",
          [org],
        );
        ids[`svc_${tag}`] = await insert(
          "insert into public.services (org_id, department_id, name) values ($1, $2, 'Consultation')",
          [org, ids[`dept_${tag}`]],
        );
        ids[`spec_${tag}`] = await insert(
          "insert into public.specialists (org_id, name, department_id) values ($1, $2, $3)",
          [org, `Dr ${tag}`, ids[`dept_${tag}`]],
        );
        ids[`contact_${tag}`] = await insert(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Test', $2)",
          [org, tag === "a" ? "+971500000001" : "+971500000002"],
        );
        ids[`appt_${tag}`] = await insert(
          `insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, starts_at, ends_at)
           values ($1, $2, $3, $4, $5, now() + interval '2 days', now() + interval '2 days 30 minutes')`,
          [org, ids[`contact_${tag}`], ids[`loc_${tag}`], ids[`spec_${tag}`], ids[`svc_${tag}`]],
        );
        await c.query(
          `insert into public.appointment_reminders (org_id, appointment_id, idx, due_at)
           values ($1, $2, 1, now() + interval '1 day')`,
          [org, ids[`appt_${tag}`]],
        );
      }
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("numbers appointments per org starting at 1", async () => {
    const { rows } = await c.query<{ org_id: string; number: string }>(
      "select org_id, number::text from public.appointments order by created_at",
    );
    expect(rows.map((r) => r.number)).toEqual(["1", "1"]);
    const second = await insert(
      `insert into public.appointments (org_id, contact_id, starts_at, ends_at)
       values ($1, $2, now() + interval '3 days', now() + interval '3 days 30 minutes')`,
      [orgA, ids.contact_a],
    );
    const { rows: n } = await c.query<{ number: string }>(
      "select number::text from public.appointments where id = $1",
      [second],
    );
    expect(n[0].number).toBe("2");
  });

  it("keeps each org's data invisible to the other", async () => {
    for (const table of [
      "locations",
      "departments",
      "services",
      "specialists",
      "appointments",
      "appointment_reminders",
    ]) {
      const aRows = await asUser(c, alice, () =>
        count(c, `select 1 from public.${table} where org_id = $1`, [orgB]),
      );
      expect(aRows, `${table}: alice must not see org B`).toBe(0);
      const bRows = await asUser(c, bob, () =>
        count(c, `select 1 from public.${table} where org_id = $1`, [orgA]),
      );
      expect(bRows, `${table}: bob must not see org A`).toBe(0);
    }
    expect(
      await asUser(c, alice, () => count(c, "select 1 from public.appointments")),
    ).toBeGreaterThan(0);
  });

  it("blocks writes into another org", async () => {
    await expect(
      asUser(c, alice, () =>
        c.query(
          `insert into public.appointments (org_id, contact_id, starts_at, ends_at)
           values ($1, $2, now() + interval '4 days', now() + interval '4 days 30 minutes')`,
          [orgB, ids.contact_b],
        ),
      ),
    ).rejects.toThrow(/row-level security|does not belong to org/);
    const upd = await asUser(c, alice, () =>
      c.query("update public.appointments set notes = 'x' where id = $1", [ids.appt_b]),
    );
    expect(upd.rowCount).toBe(0);
    const del = await asUser(c, alice, () =>
      c.query("delete from public.locations where id = $1", [ids.loc_b]),
    );
    expect(del.rowCount).toBe(0);
  });

  it("lets appointments.view read but not write; appointments.manage books", async () => {
    expect(
      await asUser(c, viewer, () =>
        count(c, "select 1 from public.appointments where org_id = $1", [orgA]),
      ),
    ).toBeGreaterThan(0);
    await expect(
      asUser(c, viewer, () =>
        c.query(
          `insert into public.appointments (org_id, contact_id, starts_at, ends_at)
           values ($1, $2, now() + interval '5 days', now() + interval '5 days 30 minutes')`,
          [orgA, ids.contact_a],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const res = await asUser(c, booker, () =>
      c.query(
        `insert into public.appointments (org_id, contact_id, starts_at, ends_at)
         values ($1, $2, now() + interval '5 days', now() + interval '5 days 30 minutes')`,
        [orgA, ids.contact_a],
      ),
    );
    expect(res.rowCount).toBe(1);
  });

  it("requires settings.manage to edit the catalogue but lets every member read it", async () => {
    expect(await asUser(c, viewer, () => count(c, "select 1 from public.specialists"))).toBe(1);
    await expect(
      asUser(c, booker, () =>
        c.query("insert into public.locations (org_id, name) values ($1, 'Annex')", [orgA]),
      ),
    ).rejects.toThrow(/row-level security/);
    const ok = await asUser(c, alice, () =>
      c.query("insert into public.locations (org_id, name) values ($1, 'Annex')", [orgA]),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("hides reminders from writes and the counter table entirely", async () => {
    await expect(
      asUser(c, booker, () =>
        c.query(
          `insert into public.appointment_reminders (org_id, appointment_id, idx, due_at)
           values ($1, $2, 2, now())`,
          [orgA, ids.appt_a],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      await asUser(c, alice, () => count(c, "select 1 from public.appointment_counters")),
    ).toBe(0);
  });

  it("rejects references that cross orgs", async () => {
    await expect(
      asServiceRole(c, () =>
        c.query(
          `insert into public.appointments (org_id, contact_id, specialist_id, starts_at, ends_at)
           values ($1, $2, $3, now() + interval '6 days', now() + interval '6 days 30 minutes')`,
          [orgA, ids.contact_a, ids.spec_b],
        ),
      ),
    ).rejects.toThrow(/does not belong to org/);
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1, $2, $3, 1, 540, 600)",
          [orgA, ids.spec_a, ids.loc_b],
        ),
      ),
    ).rejects.toThrow(/does not belong to org/);
  });

  it("enforces data integrity", async () => {
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.appointments (org_id, contact_id, starts_at, ends_at) values ($1, $2, now(), now() - interval '1 hour')",
          [orgA, ids.contact_a],
        ),
      ),
    ).rejects.toThrow();
    // Only Unite rows may lack a contact (unmatched patient waiting in Sync Review).
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.appointments (org_id, starts_at, ends_at) values ($1, now(), now() + interval '1 hour')",
          [orgA],
        ),
      ),
    ).rejects.toThrow();
    const unite = await asServiceRole(c, () =>
      c.query(
        "insert into public.appointments (org_id, starts_at, ends_at, source, external_id) values ($1, now(), now() + interval '1 hour', 'unite', 'U-1')",
        [orgA],
      ),
    );
    expect(unite.rowCount).toBe(1);
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.appointments (org_id, starts_at, ends_at, source, external_id) values ($1, now(), now() + interval '1 hour', 'unite', 'U-1')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1, $2, $3, 1, 600, 600)",
          [orgA, ids.spec_a, ids.loc_a],
        ),
      ),
    ).rejects.toThrow();
  });

  it("gates exclusions and the Unite status map behind appointments.manage", async () => {
    await asServiceRole(c, () =>
      c.query("select public.seed_unite_appointment_status_map($1)", [orgA]),
    );
    expect(
      await asUser(c, viewer, () => count(c, "select 1 from public.unite_appointment_status_map")),
    ).toBe(7);
    await expect(
      asUser(c, viewer, () =>
        c.query(
          "insert into public.reminder_exclusions (org_id, kind, value) values ($1, 'doctor', 'Dr X')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const ok = await asUser(c, booker, () =>
      c.query(
        "insert into public.reminder_exclusions (org_id, kind, value) values ($1, 'doctor', 'Dr X')",
        [orgA],
      ),
    );
    expect(ok.rowCount).toBe(1);
    const { rows } = await c.query<{ x: boolean; y: boolean }>(
      "select public.is_reminder_excluded($1, 'Anyone', 'Dr X') as x, public.is_reminder_excluded($1, 'Anyone', 'Dr Y') as y",
      [orgA],
    );
    expect(rows[0]).toEqual({ x: true, y: false });
  });

  it("filters contacts by appointment fields through contacts_search", async () => {
    const registry = buildContactFieldRegistry({});
    const search = async (
      field: string,
      op: Parameters<typeof cond>[1],
      value?: string | number,
    ) => {
      const { sql, params } = compileFilter({ include: and(cond(field, op, value)) }, registry, {
        timezone: "Asia/Dubai",
      });
      return asServiceRole(c, async () => {
        const { rows } = await c.query<{ id: string }>(
          "select id from public.contacts_search($1, $2, $3::jsonb, 'c.created_at desc', 100, 0)",
          [orgA, sql, JSON.stringify(params)],
        );
        return rows.map((r) => r.id);
      });
    };
    expect(await search("appointment_status", "eq", "awaiting")).toEqual([ids.contact_a]);
    expect(await search("appointment_status", "eq", "cancelled")).toEqual([]);
    expect(await search("appointment_count", "gte", 2)).toEqual([ids.contact_a]);
    expect(await search("appointment_count", "gte", 99)).toEqual([]);
  });
});
