/** public.reconcile_snapshot(): counts-only snapshot behind `pnpm reconcile`. */
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

type Snapshot = Record<string, unknown> & { refs: Record<string, number> };

describe.skipIf(!TEST_DATABASE_URL)("reconcile_snapshot", () => {
  let c: Client;
  let alice: string;
  let orgA: string;
  let orgB: string;
  const ids: Record<string, string> = {};

  const snap = async (org: string) =>
    asServiceRole(
      c,
      async () =>
        (await c.query<{ s: Snapshot }>("select public.reconcile_snapshot($1) as s", [org])).rows[0]
          .s,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const contact = async (key: string, org: string, cols: Record<string, unknown>) => {
        const names = ["org_id", ...Object.keys(cols)];
        const vals = [org, ...Object.values(cols)];
        const { rows } = await c.query<{ id: string }>(
          `insert into public.contacts (${names.join(",")}) values (${names.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
          vals,
        );
        ids[key] = rows[0].id;
      };
      await contact("a1", orgA, {
        first_name: "A1",
        phone_e164: "+971500900001",
        source: "import_airtable",
      });
      await contact("a2", orgA, {
        first_name: "A2",
        phone_e164: "+971500900002",
        source: "import_airtable",
      });
      await contact("a3", orgA, {
        first_name: "A3",
        external_id: "PIN-3",
        source: "import_sanoflow",
      });
      await contact("a4", orgA, { first_name: "A4", source: "manual" }); // no identifier
      await contact("gone", orgA, {
        first_name: "Gone",
        phone_e164: "+971500900009",
        source: "import_airtable",
        deleted_at: new Date().toISOString(),
      });
      await contact("b1", orgB, {
        first_name: "B1",
        phone_e164: "+971500900003",
        source: "import_airtable",
      });
      await c.query("update public.contacts set merged_into_id = $1 where id = $2", [
        ids.a1,
        ids.gone,
      ]);

      const ref = (
        org: string,
        source: string,
        entity: string,
        ext: string,
        local: string | null,
      ) =>
        c.query(
          "insert into public.external_refs (org_id, source, entity, external_id, local_table, local_id) values ($1,$2,$3,$4,'contacts',$5)",
          [org, source, entity, ext, local ?? "00000000-0000-4000-8000-00000000dead"],
        );
      await ref(orgA, "airtable", "app.tbl1", "rec1", ids.a1);
      await ref(orgA, "airtable", "app.tbl1", "rec2", ids.a2);
      await ref(orgA, "airtable", "app.tbl1", "rec3", ids.gone); // points at a deleted+merged contact (fine)
      await ref(orgA, "sanoflow", "contact", "s1", ids.a3);
      await ref(orgA, "airtable", "app.tbl1", "rec-orphan", null); // missing contact
      await ref(orgB, "airtable", "app.tbl1", "recB", ids.b1);

      await c.query(
        "insert into public.sync_reviews (org_id, source, entity, external_id, reason, status) values ($1,'airtable','app.tbl1','r1','multiple_phone','open'), ($1,'airtable','app.tbl1','r2','multiple_phone','open'), ($1,'airtable','app.tbl1','r3','x','dismissed'), ($1,'airtable','app.tbl1','r4','x','resolved')",
        [orgA],
      );

      await c.query(
        "insert into public.contact_phones (org_id, contact_id, phone_e164) values ($1,$2,'+971500900050'), ($1,$3,'+971500900050'), ($1,$2,'+971500900002')",
        [orgA, ids.a1, ids.a2],
      );
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("counts references, reviews and contacts for one org", async () => {
    const s = await snap(orgA);
    expect(s.refs).toEqual({ "airtable/app.tbl1": 4, "sanoflow/contact": 1 });
    expect(s.reviews_open).toEqual({ "airtable/app.tbl1": 2 });
    expect(s.reviews_dismissed).toEqual({ "airtable/app.tbl1": 1 });
    expect(s.reviews_resolved).toEqual({ "airtable/app.tbl1": 1 });
    expect(s.contacts_live).toBe(4);
    expect(s.contacts_imported).toBe(3);
    expect(s.contacts_without_identifier).toBe(1);
  });

  it("finds integrity problems", async () => {
    const s = await snap(orgA);
    expect(s.orphan_refs).toBe(1);
    expect(s.refs_to_deleted_contacts).toBe(0); // the deleted contact was merged, so its ref is fine
    expect(s.duplicate_alternate_phones).toBe(1); // +…050 on two live contacts
    expect(s.alternate_phone_is_other_primary).toBe(1); // a1's alternate +…002 is a2's primary
    expect(s.merge_chains_over_1).toBe(0);
  });

  it("is scoped to the org it is asked about", async () => {
    const s = await snap(orgB);
    expect(s.refs).toEqual({ "airtable/app.tbl1": 1 });
    expect(s.orphan_refs).toBe(0);
    expect(s.contacts_live).toBe(1);
  });

  it("returns counts only (no row content)", async () => {
    const text = JSON.stringify(await snap(orgA));
    for (const needle of ["A1", "+9715009", "rec1", "PIN-3", "@"])
      expect(text).not.toContain(needle);
  });

  it("is not callable by signed-in users", async () => {
    await asUser(c, alice, async () => {
      await expect(c.query("select public.reconcile_snapshot($1)", [orgA])).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
