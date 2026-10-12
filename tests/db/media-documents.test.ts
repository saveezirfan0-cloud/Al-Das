/**
 * Phase 16 database behaviour: the Media Library and patient documents. Permission gating (documents.* is not
 * inherited from contacts.*), cross-org isolation, that a browser session can never write these tables, the
 * "in use" guard that blocks deleting a library file, merge and erasure, the retention table's constraints and the
 * data migration that grants the new permissions to existing system roles. Synthetic data only; no file is uploaded.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

describe.skipIf(!TEST_DATABASE_URL)("phase 16: media library and patient documents", () => {
  let c: Client;
  let alice: string; // admin A ('*')
  let bob: string; // admin B
  let librarian: string; // A: media.view only
  let mediaMgr: string; // A: media.manage only
  let clerk: string; // A: documents.view only
  let docMgr: string; // A: documents.manage only (cannot view)
  let agent: string; // A: contacts.view + inbox.send + contacts.manage, no documents or media
  let orgA: string;
  let orgB: string;
  const ids: Record<string, string> = {};

  async function one(sql: string, params: unknown[] = []): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id::text", params);
    return rows[0].id;
  }
  async function tryQuery(sql: string, params: unknown[] = []) {
    await c.query("begin");
    try {
      const r = await c.query(sql, params);
      await c.query("commit");
      return { ok: true as const, rowCount: r.rowCount ?? 0, rows: r.rows };
    } catch (e) {
      await c.query("rollback");
      return {
        ok: false as const,
        code: (e as { code?: string }).code,
        message: (e as Error).message,
      };
    }
  }
  const uuid = async () =>
    (await c.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0].id;

  async function asset(org: string, over: Record<string, string> = {}): Promise<string> {
    const id = await uuid();
    await one(
      "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status) values ($1, $2, $3, 'image', 'image/jpeg', 100, $4, 'ready')",
      [id, org, over.name ?? "Asset", `${org}/${id}/original.jpg`],
    );
    return id;
  }
  async function template(
    org: string,
    assetId: string,
    status: string,
    archived = false,
  ): Promise<string> {
    return one(
      "insert into public.wa_templates (org_id, waba_id, name, language, status, variable_map, archived_at) values ($1, 'waba-' || gen_random_uuid()::text, 't-' || gen_random_uuid()::text, 'en', $2, $3::jsonb, $4) ",
      [
        org,
        status,
        JSON.stringify({ "header.media": `media:${assetId}` }),
        archived ? new Date().toISOString() : null,
      ],
    );
  }
  async function channel(org: string): Promise<string> {
    return one(
      "insert into public.channels (org_id, name, phone_number_id, waba_id) values ($1, 'Seed line', 'pn-' || gen_random_uuid()::text, 'waba-x')",
      [org],
    );
  }
  async function campaign(
    org: string,
    tpl: string,
    ch: string,
    assetId: string,
    status: string,
  ): Promise<string> {
    return one(
      "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, variable_map, status) values ($1, 'C', $2, $3, 'csv', $4::jsonb, $5)",
      [
        org,
        ch,
        tpl,
        JSON.stringify({ "header.media": `media:${assetId}`, "body.1": "contact.first_name" }),
        status,
      ],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    librarian = await createAuthUser(c, "librarian@example.test");
    mediaMgr = await createAuthUser(c, "mediamgr@example.test");
    clerk = await createAuthUser(c, "clerk@example.test");
    docMgr = await createAuthUser(c, "docmgr@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      for (const [user, name, perms] of [
        [librarian, "Librarian", ["media.view"]],
        [mediaMgr, "Media manager", ["media.manage"]],
        [clerk, "Clerk", ["documents.view", "contacts.view"]],
        [docMgr, "Doc manager", ["documents.manage", "contacts.view"]],
        [
          agent,
          "Plain agent",
          ["contacts.view", "contacts.manage", "inbox.send", "inbox.view_all"],
        ],
      ] as const) {
        const roleId = await one(
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
        ids[`folder_${tag}`] = await one(
          "insert into public.media_folders (org_id, name) values ($1, 'Offers')",
          [org],
        );
        ids[`asset_${tag}`] = await asset(org, { name: `Poster ${tag}` });
        ids[`contact_${tag}`] = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Doc', 'Patient', $2)",
          [org, tag === "a" ? "+971500000171" : "+971500000172"],
        );
        const docId = await uuid();
        ids[`doc_${tag}`] = await one(
          "insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, $3, 'lab_report', 'Synthetic lab report', 'application/pdf', 500, $4, 'ready')",
          [docId, org, ids[`contact_${tag}`], `${org}/${ids[`contact_${tag}`]}/${docId}.pdf`],
        );
        await c.query(
          "insert into public.document_retention_policies (org_id, category, retain_days) values ($1, 'referral', 400)",
          [org],
        );
      }
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("permissions", () => {
    it("the library is visible with media.view or media.manage, and to nobody without them", async () => {
      for (const [who, expected] of [
        [alice, 1],
        [librarian, 1],
        [mediaMgr, 1],
        [clerk, 0],
        [docMgr, 0],
        [agent, 0],
      ] as const) {
        await asUser(c, who, async () => {
          expect(
            await count(c, "select 1 from public.media_assets where org_id = $1", [orgA]),
            who,
          ).toBe(expected);
          expect(
            await count(c, "select 1 from public.media_folders where org_id = $1", [orgA]),
            who,
          ).toBe(expected);
        });
      }
    });

    it("patient documents need documents.view: contacts.view, inbox rights and documents.manage alone do not open them", async () => {
      for (const [who, expected] of [
        [alice, 1],
        [clerk, 1],
        [docMgr, 0],
        [agent, 0],
        [librarian, 0],
        [mediaMgr, 0],
      ] as const) {
        await asUser(c, who, async () => {
          expect(
            await count(c, "select 1 from public.patient_documents where org_id = $1", [orgA]),
            who,
          ).toBe(expected);
        });
      }
      // The agent can still read the patient record itself (the permission is not inherited the other way either).
      await asUser(c, agent, async () => {
        expect(await count(c, "select 1 from public.contacts where id = $1", [ids.contact_a])).toBe(
          1,
        );
      });
    });

    it("retention policies are visible to documents.manage or settings.manage only", async () => {
      for (const [who, expected] of [
        [alice, 1],
        [docMgr, 1],
        [clerk, 0],
        [agent, 0],
        [librarian, 0],
      ] as const) {
        await asUser(c, who, async () => {
          expect(
            await count(c, "select 1 from public.document_retention_policies where org_id = $1", [
              orgA,
            ]),
            who,
          ).toBe(expected);
        });
      }
    });

    it("hides every org A row from org B's admin and vice versa", async () => {
      await asUser(c, bob, async () => {
        for (const t of [
          "media_folders",
          "media_assets",
          "patient_documents",
          "document_retention_policies",
        ])
          expect(await count(c, `select 1 from public.${t} where org_id = $1`, [orgA]), t).toBe(0);
        expect(
          await count(c, "select 1 from public.patient_documents where id = $1", [ids.doc_a]),
        ).toBe(0);
      });
      await asUser(c, alice, async () => {
        for (const t of [
          "media_folders",
          "media_assets",
          "patient_documents",
          "document_retention_policies",
        ])
          expect(await count(c, `select 1 from public.${t} where org_id = $1`, [orgB]), t).toBe(0);
      });
    });

    it("a browser session can never write these tables, whatever its role (writes are server-only)", async () => {
      const writers = [alice, mediaMgr, docMgr];
      for (const who of writers) {
        await asUser(c, who, async () => {
          const inserts: Array<[string, string, unknown[]]> = [
            [
              "media_folders",
              "insert into public.media_folders (org_id, name) values ($1, 'x')",
              [orgA],
            ],
            [
              "media_assets",
              "insert into public.media_assets (org_id, name, kind, mime_type, size_bytes, storage_path) values ($1, 'x', 'image', 'image/png', 1, 'p-' || gen_random_uuid()::text)",
              [orgA],
            ],
            [
              "patient_documents",
              "insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path) values ($1, $2, 'other', 'x', 'application/pdf', 1, 'p-' || gen_random_uuid()::text)",
              [orgA, ids.contact_a],
            ],
            [
              "document_retention_policies",
              "insert into public.document_retention_policies (org_id, category) values ($1, 'consent')",
              [orgA],
            ],
          ];
          for (const [t, sql, p] of inserts) {
            const r = await tryQuery(sql, p);
            // patient_documents has a BEFORE INSERT org check that cannot see a contact the caller may not read (23514);
            // everyone else is stopped by row level security (42501). Either way nothing is written.
            expect(
              r.ok === false &&
                ["42501", ...(t === "patient_documents" ? ["23514"] : [])].includes(r.code!),
              `${who} insert ${t}`,
            ).toBe(true);
          }
          // update and delete match no row under RLS, so they change nothing
          for (const t of ["media_folders", "media_assets", "patient_documents"]) {
            const u = await tryQuery(
              `update public.${t} set created_at = created_at where org_id = $1`,
              [orgA],
            );
            expect(u.ok && u.rowCount, `${who} update ${t}`).toBe(0);
            const d = await tryQuery(`delete from public.${t} where org_id = $1`, [orgA]);
            expect(d.ok && d.rowCount, `${who} delete ${t}`).toBe(0);
          }
        });
      }
      expect(
        await count(c, "select 1 from public.patient_documents where org_id = $1", [orgA]),
      ).toBe(1);
      expect(await count(c, "select 1 from public.media_assets where org_id = $1", [orgA])).toBe(1);
    });

    it("cannot call the usage function from a browser session", async () => {
      await asUser(c, alice, async () => {
        const r = await tryQuery("select * from public.media_asset_usage($1, $2)", [
          orgA,
          ids.asset_a,
        ]);
        expect(r.ok === false && r.code).toBe("42501");
      });
    });
  });

  describe("permission grant for existing roles (data migration)", () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261015000100_media_library.sql"),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)![0];

    it("adds media.* and documents.* to the right system roles only, and is idempotent", async () => {
      const org = await asServiceRole(c, async () => {
        const o = await one("insert into public.orgs (name, slug) values ('Grants', 'grants')");
        for (const name of [
          "Manager",
          "Agent",
          "Receptionist",
          "Care coordinator",
          "Marketing",
          "Finance",
          "Admin",
        ])
          await c.query(
            "insert into public.roles (org_id, name, permissions, is_system) values ($1, $2, '[\"inbox.send\"]'::jsonb, true)",
            [o, name],
          );
        await c.query(
          "insert into public.roles (org_id, name, permissions, is_system) values ($1, 'Custom', '[\"inbox.send\"]'::jsonb, false)",
          [o],
        );
        await c.query(block);
        await c.query(block);
        return o;
      });
      const { rows } = await c.query<{ name: string; permissions: string[] }>(
        "select name, permissions from public.roles where org_id = $1",
        [org],
      );
      const perms = (n: string) => rows.find((r) => r.name === n)!.permissions;
      const has = (n: string, p: string) => perms(n).includes(p);
      for (const p of ["media.view", "media.manage", "documents.view", "documents.manage"])
        expect(has("Manager", p), p).toBe(true);
      expect(has("Agent", "media.view")).toBe(true);
      expect(has("Agent", "documents.view")).toBe(false);
      expect(has("Receptionist", "documents.manage")).toBe(true);
      expect(has("Care coordinator", "documents.view")).toBe(true);
      expect(has("Marketing", "media.manage")).toBe(true);
      expect(has("Marketing", "documents.view")).toBe(false);
      for (const n of ["Finance", "Admin", "Custom"]) expect(perms(n)).toEqual(["inbox.send"]);
      expect(perms("Manager").filter((p) => p === "media.view").length).toBe(1);
    });
  });

  describe("media_asset_usage and the delete guard", () => {
    let ch: string;
    beforeAll(async () => {
      await asServiceRole(c, async () => {
        ch = await channel(orgA);
      });
    });

    const usage = async (assetId: string) =>
      asServiceRole(
        c,
        async () =>
          (
            await c.query<{ kind: string; blocking: boolean }>(
              "select kind, blocking from public.media_asset_usage($1, $2) order by kind",
              [orgA, assetId],
            )
          ).rows,
      );
    const del = (assetId: string) =>
      asServiceRole(c, () => tryQuery("delete from public.media_assets where id = $1", [assetId]));

    it("an unused asset has no usage and can be deleted", async () => {
      const a = await asset(orgA);
      expect(await usage(a)).toEqual([]);
      expect((await del(a)).ok).toBe(true);
    });

    it("a live template blocks the delete; an archived, rejected or disabled one does not", async () => {
      for (const [status, archived, blocks] of [
        ["APPROVED", false, true],
        ["PENDING", false, true],
        ["DRAFT", false, true],
        ["PAUSED", false, true],
        ["APPROVED", true, false],
        ["REJECTED", false, false],
        ["DISABLED", false, false],
      ] as const) {
        const a = await asset(orgA);
        const t = await asServiceRole(c, () => template(orgA, a, status, archived));
        const u = await usage(a);
        expect(u, `${status}/${archived}`).toEqual([{ kind: "template", blocking: blocks }]);
        const r = await del(a);
        if (blocks) expect(r.ok === false && r.code, `${status}`).toBe("23001");
        else expect(r.ok, `${status}`).toBe(true);
        await asServiceRole(c, () => c.query("delete from public.wa_templates where id = $1", [t]));
        if (blocks) expect((await del(a)).ok).toBe(true); // free again once the template is gone
      }
    });

    it("an active campaign blocks; a finished or cancelled one only informs", async () => {
      const tplAsset = await asset(orgA);
      const tpl = await asServiceRole(c, () =>
        one(
          "insert into public.wa_templates (org_id, waba_id, name, language, status) values ($1, 'waba-c', 'camp-' || gen_random_uuid()::text, 'en', 'APPROVED')",
          [orgA],
        ),
      );
      for (const [status, blocks] of [
        ["preparing", true],
        ["scheduled", true],
        ["queued", true],
        ["sending", true],
        ["paused", true],
        ["completed", false],
        ["cancelled", false],
        ["failed", false],
      ] as const) {
        const a = await asset(orgA);
        const camp = await asServiceRole(c, () => campaign(orgA, tpl, ch, a, status));
        expect(await usage(a), status).toEqual([{ kind: "campaign", blocking: blocks }]);
        const r = await del(a);
        if (blocks) expect(r.ok === false && r.code, status).toBe("23001");
        else expect(r.ok, status).toBe(true);
        await asServiceRole(c, () => c.query("delete from public.campaigns where id = $1", [camp]));
      }
      await del(tplAsset);
    });

    it("a quick reply blocks the delete (by the guard and by the foreign key)", async () => {
      const a = await asset(orgA);
      const q = await asServiceRole(c, () =>
        one(
          "insert into public.quick_replies (org_id, shortcut, text, media_asset_id) values ($1, 'brochure', 'Here is our brochure', $2)",
          [orgA, a],
        ),
      );
      expect(await usage(a)).toEqual([{ kind: "quick_reply", blocking: true }]);
      expect((await del(a)).ok).toBe(false);
      await asServiceRole(c, () => c.query("delete from public.quick_replies where id = $1", [q]));
      expect((await del(a)).ok).toBe(true);
    });

    it("does not confuse another org's asset id, nor a different asset", async () => {
      const a = await asset(orgA);
      const other = await asset(orgA);
      const t = await asServiceRole(c, () => template(orgA, other, "APPROVED"));
      expect(await usage(a)).toEqual([]);
      const crossOrg = await asServiceRole(
        c,
        async () =>
          (await c.query("select * from public.media_asset_usage($1, $2)", [orgB, other])).rows,
      );
      expect(crossOrg).toEqual([]);
      await asServiceRole(c, () => c.query("delete from public.wa_templates where id = $1", [t]));
    });

    it("rejects a quick reply that points at another org's asset", async () => {
      const r = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.quick_replies (org_id, shortcut, text, media_asset_id) values ($1, 'sneaky', 'x', $2)",
          [orgA, ids.asset_b],
        ),
      );
      expect(r.ok === false && r.code).toBe("23514");
    });

    it("lets a whole org be deleted even though its assets are in use", async () => {
      const org = await asServiceRole(c, async () => {
        const o = await one("insert into public.orgs (name, slug) values ('Gone', 'gone')");
        const a = await asset(o);
        await c.query(
          "insert into public.quick_replies (org_id, shortcut, text, media_asset_id) values ($1, 'x', 'y', $2)",
          [o, a],
        );
        return o;
      });
      const r = await asServiceRole(c, () =>
        tryQuery("delete from public.orgs where id = $1", [org]),
      );
      expect(r.ok, r.ok ? "" : r.message).toBe(true);
      expect(await count(c, "select 1 from public.media_assets where org_id = $1", [org])).toBe(0);
    });
  });

  describe("table constraints", () => {
    it("keeps folder names unique per org, case-insensitively", async () => {
      const r = await asServiceRole(c, () =>
        tryQuery("insert into public.media_folders (org_id, name) values ($1, 'OFFERS')", [orgA]),
      );
      expect(r.ok === false && r.code).toBe("23505");
      const other = await asServiceRole(c, () =>
        tryQuery("insert into public.media_folders (org_id, name) values ($1, 'Offers')", [orgB]),
      );
      expect(other.ok === false).toBe(true); // org B already has one
    });

    it("refuses a folder or contact from another org", async () => {
      const f = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.media_assets (org_id, folder_id, name, kind, mime_type, size_bytes, storage_path) values ($1, $2, 'x', 'image', 'image/png', 1, 'p-' || gen_random_uuid()::text)",
          [orgA, ids.folder_b],
        ),
      );
      expect(f.ok === false && f.code).toBe("23514");
      const d = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path) values ($1, $2, 'other', 'x', 'application/pdf', 1, 'p-' || gen_random_uuid()::text)",
          [orgA, ids.contact_b],
        ),
      );
      expect(d.ok === false && d.code).toBe("23514");
    });

    it("validates categories, sizes, titles and kinds", async () => {
      const base = (over: string) =>
        `insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path) values ($1, $2, ${over})`;
      for (const bad of [
        "'passport', 'x', 'application/pdf', 1, 'p1'",
        "'other', '', 'application/pdf', 1, 'p2'",
        `'other', '${"x".repeat(121)}', 'application/pdf', 1, 'p3'`,
        "'other', 'x', 'application/pdf', 0, 'p4'",
      ]) {
        const r = await asServiceRole(c, () => tryQuery(base(bad), [orgA, ids.contact_a]));
        expect(r.ok === false && r.code, bad).toBe("23514");
      }
      const k = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.media_assets (org_id, name, kind, mime_type, size_bytes, storage_path) values ($1, 'x', 'audio', 'audio/ogg', 1, 'p5')",
          [orgA],
        ),
      );
      expect(k.ok === false && k.code).toBe("23514");
      const tags = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.media_assets (org_id, name, kind, mime_type, size_bytes, storage_path, tags) values ($1, 'x', 'image', 'image/png', 1, 'p6', $2)",
          [orgA, Array.from({ length: 11 }, (_, i) => `t${i}`)],
        ),
      );
      expect(tags.ok === false && tags.code).toBe("23514");
    });

    it("defaults new uploads to pending and unscanned, so an unchecked file is never mistaken for a clean one", async () => {
      const id = await asServiceRole(c, () =>
        one(
          "insert into public.media_assets (org_id, name, kind, mime_type, size_bytes, storage_path) values ($1, 'x', 'image', 'image/png', 1, 'p-' || gen_random_uuid()::text)",
          [orgA],
        ),
      );
      const { rows } = await c.query(
        "select status, scan_status from public.media_assets where id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ status: "pending", scan_status: "unscanned" });
      await asServiceRole(c, () => c.query("delete from public.media_assets where id = $1", [id]));
    });

    it("keeps storage paths unique", async () => {
      const { rows } = await c.query<{ storage_path: string }>(
        "select storage_path from public.patient_documents where id = $1",
        [ids.doc_a],
      );
      const r = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.patient_documents (org_id, contact_id, category, title, mime_type, size_bytes, storage_path) values ($1, $2, 'other', 'x', 'application/pdf', 1, $3)",
          [orgA, ids.contact_a, rows[0].storage_path],
        ),
      );
      expect(r.ok === false && r.code).toBe("23505");
    });

    it("validates retention policies: 30 days to 100 years, and auto-delete needs a period", async () => {
      for (const sql of [
        "insert into public.document_retention_policies (org_id, category, retain_days) values ($1, 'consent', 29)",
        "insert into public.document_retention_policies (org_id, category, retain_days) values ($1, 'consent', 36501)",
        "insert into public.document_retention_policies (org_id, category, auto_delete) values ($1, 'consent', true)",
        "insert into public.document_retention_policies (org_id, category, retain_days) values ($1, 'passport', 100)",
      ]) {
        const r = await asServiceRole(c, () => tryQuery(sql, [orgA]));
        expect(r.ok === false && r.code, sql).toBe("23514");
      }
      const dup = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.document_retention_policies (org_id, category, retain_days) values ($1, 'referral', 100)",
          [orgA],
        ),
      );
      expect(dup.ok === false && dup.code).toBe("23505");
      const ok = await asServiceRole(c, () =>
        tryQuery(
          "insert into public.document_retention_policies (org_id, category, retain_days, auto_delete) values ($1, 'consent', 30, true)",
          [orgA],
        ),
      );
      expect(ok.ok).toBe(true);
      await asServiceRole(c, () =>
        c.query(
          "delete from public.document_retention_policies where org_id = $1 and category = 'consent'",
          [orgA],
        ),
      );
    });

    it("schedules the daily maintenance task", async () => {
      await asServiceRole(c, async () => {
        const { rows } = await c.query<{ jobname: string }>(
          "select jobname from public.job_cron_status()",
        );
        expect(rows.map((r) => r.jobname)).toContain("pulse:documents_maintenance");
      });
    });
  });

  describe("merge and erasure", () => {
    it("moves documents to the surviving patient when two records are merged", async () => {
      await asServiceRole(c, async () => {
        const keep = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Keep', 'Patient', '+971500000173')",
          [orgA],
        );
        const lose = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Lose', 'Patient', '+971500000174')",
          [orgA],
        );
        const docId = await uuid();
        await one(
          "insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, $3, 'consent', 'Synthetic consent', 'application/pdf', 5, $4, 'ready')",
          [docId, orgA, lose, `${orgA}/${lose}/${docId}.pdf`],
        );
        await c.query("select public.merge_contacts($1, $2, $3, '{}'::jsonb, $4)", [
          orgA,
          keep,
          lose,
          alice,
        ]);
        const { rows } = await c.query(
          "select contact_id from public.patient_documents where id = $1",
          [docId],
        );
        expect(rows[0].contact_id).toBe(keep);
        await c.query("delete from public.patient_documents where id = $1", [docId]);
      });
    });

    it("erase_contact deletes the patient's documents, reports how many, and leaves everyone else's", async () => {
      const { patient, other, otherOrgDoc } = await asServiceRole(c, async () => {
        const p = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Erase', 'Me', '+971500000175')",
          [orgA],
        );
        const o = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Keep', 'Me', '+971500000176')",
          [orgA],
        );
        for (const [contact, n] of [
          [p, 3],
          [o, 1],
        ] as const) {
          for (let i = 0; i < n; i++) {
            const docId = await uuid();
            await one(
              "insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, $3, 'referral', 'Synthetic referral', 'application/pdf', 5, $4, 'ready')",
              [docId, orgA, contact, `${orgA}/${contact}/${docId}.pdf`],
            );
          }
        }
        return { patient: p, other: o, otherOrgDoc: ids.doc_b };
      });
      let result: Record<string, number> = {};
      await asServiceRole(c, async () => {
        result = (
          await c.query("select public.erase_contact($1, $2, $3) as r", [orgA, patient, alice])
        ).rows[0].r;
      });
      expect(result.documents_deleted).toBe(3);
      expect(
        await count(c, "select 1 from public.patient_documents where contact_id = $1", [patient]),
      ).toBe(0);
      expect(
        await count(c, "select 1 from public.patient_documents where contact_id = $1", [other]),
      ).toBe(1);
      expect(
        await count(c, "select 1 from public.patient_documents where id = $1", [otherOrgDoc]),
      ).toBe(1);
      const { rows } = await c.query(
        "select diff from public.audit_log where entity = 'contact' and entity_id = $1 and action = 'contact.erased'",
        [patient],
      );
      expect(rows[0].diff.documents_deleted).toBe(3);
    });

    it("still reports zero documents for a patient who had none", async () => {
      const contact = await asServiceRole(c, () =>
        one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'No', 'Docs', '+971500000177')",
          [orgA],
        ),
      );
      const r = await asServiceRole(
        c,
        async () =>
          (await c.query("select public.erase_contact($1, $2, $3) as r", [orgA, contact, alice]))
            .rows[0].r,
      );
      expect(r.documents_deleted).toBe(0);
    });
  });
});
