/**
 * Patient 360 (docs/45 P3) on Postgres: the clinical.view permission.
 *   - a member with only contacts.view (or the old-style roles without a clinical key) reads no visits, diagnoses,
 *     prescriptions, chronic conditions, follow-ups or feedback;
 *   - clinical.view reads them in the member's own organisation, and never another organisation's;
 *   - the old portal key still works;
 *   - visits follow the branch rule (a visit in an unassigned branch is hidden; a visit with no branch stays visible);
 *   - the migration's role grant adds the key to the system Doctor / Medical Director / Care coordinator roles only,
 *     is idempotent, and leaves other roles alone;
 *   - nothing becomes writable from a browser.
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("clinical.view", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let plain: string;
  let doctor: string;
  let portalOnly: string;
  let northDoctor: string;
  let stranger: string;
  const loc: Record<string, string> = {};
  let contact: string;

  const one = async (sql: string, p: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", p)).rows[0].id;

  const countAs = (user: string, table: string, where = "true") =>
    asUser(c, user, async () =>
      Number(
        (
          await c.query<{ n: string }>(
            `select count(*)::text as n from public.${table} where ${where}`,
          )
        ).rows[0].n,
      ),
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-p3@example.test");
    plain = await createAuthUser(c, "plain-p3@example.test");
    doctor = await createAuthUser(c, "doctor-p3@example.test");
    portalOnly = await createAuthUser(c, "portal-p3@example.test");
    northDoctor = await createAuthUser(c, "north-p3@example.test");
    stranger = await createAuthUser(c, "stranger-p3@example.test");
    org = await createOrg(c, "Org P3", "org-p3", owner);
    otherOrg = await createOrg(c, "Org P3 Other", "org-p3-other", stranger);

    await asServiceRole(c, async () => {
      const role = async (name: string, perms: string[], system = false) =>
        one(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, 'synthetic', $3::jsonb, $4)",
          [org, name, JSON.stringify(perms), system],
        );
      const member = (user: string, roleId: string) =>
        c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
          org,
          user,
          roleId,
        ]);
      await member(plain, await role("Plain test", ["contacts.view", "appointments.view"]));
      await member(doctor, await role("Clinical test", ["contacts.view", "clinical.view"]));
      await member(
        portalOnly,
        await role("Portal test", ["contacts.view", "portal.clinical_visits.read"]),
      );
      const northRole = await role("North clinical test", ["contacts.view", "clinical.view"]);
      await member(northDoctor, northRole);

      for (const name of ["North", "South"])
        loc[name] = await one("insert into public.locations (org_id, name) values ($1, $2)", [
          org,
          name,
        ]);

      contact = await one(
        "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Layla', 'Demo-01')",
        [org],
      );
      const otherContact = await one(
        "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Omar', 'Demo-02')",
        [otherOrg],
      );

      const visit = (orgId: string, contactId: string, ext: string, locId: string | null) =>
        one(
          "insert into public.visits (org_id, contact_id, external_id, visit_date, location_id) values ($1, $2, $3, current_date - 10, $4)",
          [orgId, contactId, ext, locId],
        );
      const vNorth = await visit(org, contact, "SYN-N", loc.North);
      await visit(org, contact, "SYN-S", loc.South);
      await visit(org, contact, "SYN-X", null);
      const vOther = await visit(otherOrg, otherContact, "SYN-O", null);

      await c.query(
        "insert into public.visit_diagnoses (org_id, visit_id, contact_id, diagnosis_code, visit_date) values ($1, $2, $3, 'J00', current_date - 10)",
        [org, vNorth, contact],
      );
      await c.query(
        "insert into public.prescriptions (org_id, visit_id, contact_id, external_key, medication_name) values ($1, $2, $3, 'SYN-N-1', 'Synthetic tablet')",
        [org, vNorth, contact],
      );
      await c.query(
        "insert into public.clinical_followups (org_id, visit_id, contact_id, due_date) values ($1, $2, $3, current_date)",
        [org, vNorth, contact],
      );
      await c.query(
        "insert into public.clinical_feedback (org_id, visit_id, contact_id, stage) values ($1, $2, $3, (select (enum_range(null::public.feedback_stage))[1]))",
        [org, vNorth, contact],
      );
      await c.query(
        "insert into public.visit_diagnoses (org_id, visit_id, contact_id, diagnosis_code, visit_date) values ($1, $2, $3, 'J00', current_date - 10)",
        [otherOrg, vOther, otherContact],
      );

      // North doctor sees the North branch only.
      const membershipId = (
        await c.query<{ id: string }>(
          "select id::text from public.memberships where org_id = $1 and user_id = $2",
          [org, northDoctor],
        )
      ).rows[0].id;
      await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [
        membershipId,
      ]);
      await c.query(
        "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
        [org, membershipId, loc.North],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const TABLES = [
    "visits",
    "visit_diagnoses",
    "prescriptions",
    "clinical_followups",
    "clinical_feedback",
  ];

  it("(i) a member with contacts.view only reads no clinical rows", async () => {
    for (const t of TABLES) expect(await countAs(plain, t), t).toBe(0);
    expect(await countAs(plain, "contact_chronic_conditions")).toBe(0);
  });

  it("(ii) clinical.view reads the clinical rows of its own organisation", async () => {
    expect(await countAs(doctor, "visits")).toBe(3);
    for (const t of TABLES.slice(1)) expect(await countAs(doctor, t), t).toBe(1);
  });

  it("keeps working for the old portal key", async () => {
    expect(await countAs(portalOnly, "visits")).toBe(3);
    expect(await countAs(portalOnly, "visit_diagnoses")).toBe(1);
  });

  it("(iii) never reads another organisation's rows", async () => {
    // The other organisation's admin sees only their own visit, none of ours.
    expect(await countAs(stranger, "visits")).toBe(1);
    expect(await countAs(stranger, "visits", `org_id = '${org}'`)).toBe(0);
    expect(await countAs(stranger, "visit_diagnoses", `org_id = '${org}'`)).toBe(0);
    expect(await countAs(owner, "visits", "external_id = 'SYN-O'")).toBe(0);
    expect(await countAs(owner, "visit_diagnoses", `org_id = '${otherOrg}'`)).toBe(0);
    expect(await countAs(doctor, "visits", `org_id = '${otherOrg}'`)).toBe(0);
  });

  it("(iv) the branch rule hides a visit in an unassigned branch; a visit with no branch stays visible", async () => {
    const seen = await asUser(c, northDoctor, async () =>
      (
        await c.query<{ external_id: string }>(
          "select external_id from public.visits order by external_id",
        )
      ).rows.map((r) => r.external_id),
    );
    expect(seen).toEqual(["SYN-N", "SYN-X"]);
    const all = await asUser(c, doctor, async () =>
      (
        await c.query<{ external_id: string }>(
          "select external_id from public.visits order by external_id",
        )
      ).rows.map((r) => r.external_id),
    );
    expect(all).toEqual(["SYN-N", "SYN-S", "SYN-X"]);
  });

  it("nothing is writable from a browser with clinical.view", async () => {
    const rows = await asUser(c, doctor, async () => {
      await c.query("begin");
      await c.query("savepoint s");
      try {
        const r = await c.query("update public.visits set doctor_name = 'x' returning 1");
        return r.rowCount;
      } catch {
        return 0;
      } finally {
        await c.query("rollback");
      }
    });
    expect(rows).toBe(0);
    const insert = await asUser(c, doctor, async () => {
      await c.query("begin");
      try {
        await c.query(
          "insert into public.visits (org_id, external_id, visit_date) values ($1, 'SYN-W', current_date)",
          [org],
        );
        return "inserted";
      } catch {
        return "refused";
      } finally {
        await c.query("rollback");
      }
    });
    expect(insert).toBe("refused");
  });

  describe("role grant (migration step 1)", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "20261220000100_clinical_view.sql"),
      "utf8",
    );
    const grant = /update public\.roles r[\s\S]*?;/.exec(sql)![0];

    it("adds the key to the system clinical roles only, once", async () => {
      const ids = await asServiceRole(c, async () => {
        const mk = async (name: string, system: boolean, orgId = org) =>
          one(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, 'synthetic', '[\"contacts.view\"]'::jsonb, $3)",
            [orgId, name, system],
          );
        return {
          doctor: await mk("Doctor", true),
          md: await mk("Medical Director", true),
          cc: await mk("Care coordinator", true),
          receptionist: await mk("Receptionist", true),
          custom: await mk("Doctor", false, otherOrg),
        };
      });
      await asServiceRole(c, async () => {
        await c.query(grant);
        await c.query(grant); // idempotent
      });
      const perms = async (id: string) =>
        (
          await c.query<{ permissions: string[] }>(
            "select permissions from public.roles where id = $1",
            [id],
          )
        ).rows[0].permissions;
      for (const id of [ids.doctor, ids.md, ids.cc])
        expect((await perms(id)).filter((p) => p === "clinical.view")).toHaveLength(1);
      expect(await perms(ids.receptionist)).not.toContain("clinical.view");
      expect(await perms(ids.custom)).not.toContain("clinical.view");
    });
  });
});
