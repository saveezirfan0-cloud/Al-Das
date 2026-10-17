/**
 * Care-only segments and the consent rule in SQL (docs/45 P5 follow-up). Synthetic data only. Needs TEST_DATABASE_URL.
 *   - a dynamic segment with a clinical / care-only field is always care only, whoever writes it
 *   - a care-only mark can be released only through public.segment_set_care_only (service role)
 *   - campaign_snapshot_segment refuses a marketing snapshot of a care-only segment, a missing segment and a segment
 *     that is not the campaign's own; a care purpose passes
 *   - a segment that includes a care-only segment is care only (checked again at use time)
 *   - the SQL list of marketing-safe fields equals the TypeScript registry
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, cond, type Filter } from "@/lib/filters/ast";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const f = (...conds: ReturnType<typeof cond>[]): Filter => ({
  include: and(...conds),
  exclude: null,
});

describe.skipIf(!TEST_DATABASE_URL)("Care-only segments (docs/45 P5 follow-up)", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let stranger: string;
  let channel: string;
  let template: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) =>
    (await q(`${sql} returning id::text`, p)).rows[0].id as string;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const segment = (name: string, kind: "static" | "dynamic", filter?: Filter, careOnly = false) =>
    svc(() =>
      one(
        `insert into public.segments (org_id, name, kind, filter, care_only, care_only_reason)
         values ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          org,
          name,
          kind,
          filter ? JSON.stringify(filter) : null,
          careOnly,
          careOnly ? "manual" : null,
        ],
      ),
    );
  const flag = async (segId: string) =>
    (
      await svc(() =>
        q("select care_only, care_only_reason from public.segments where id = $1", [segId]),
      )
    ).rows[0] as { care_only: boolean; care_only_reason: string | null };
  const snapshot = (campaign: string, segId: string | null, purpose: string, dry = false) =>
    svc(() =>
      q(
        "select public.campaign_snapshot_segment($1, $2, 'true', '[]'::jsonb, false, 1000, $3, $4, $5) as r",
        [org, campaign, dry, segId, purpose],
      ),
    );
  const campaignFor = (name: string, segId: string | null) =>
    svc(() =>
      one(
        "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, segment_id) values ($1, $2, $3, $4, 'segment', $5)",
        [org, name, channel, template, segId],
      ),
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-co@example.test");
    stranger = await createAuthUser(c, "stranger-co@example.test");
    org = await createOrg(c, "Org CO", "org-co", owner);
    otherOrg = await createOrg(c, "Org CO Other", "org-co-other", stranger);
    await svc(async () => {
      channel = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id, display_phone) values ($1, 'Demo', 'waba-co', 'pn-co', '+447700900001')",
        [org],
      );
      template = await one(
        "insert into public.wa_templates (org_id, name, language, category, status, waba_id) values ($1, 'demo_co', 'en', 'UTILITY', 'APPROVED', 'waba-co')",
        [org],
      );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("marks a dynamic segment care only when its filter uses a clinical or care-only field", async () => {
    for (const [name, filter] of [
      ["lifecycle", f(cond("lifecycle_stage", "in", ["active"]))],
      ["doctor", f(cond("visit_doctor", "in", ["00000000-0000-0000-0000-000000000001"]))],
      [
        "appointment doctor",
        f(cond("appointment_specialist", "in", ["00000000-0000-0000-0000-000000000001"])),
      ],
      ["appointment notes", f(cond("appointment_notes", "contains", "x"))],
      ["ai tags", f(cond("conversation_ai_tags", "contains", "x"))],
      ["unknown", f(cond("some_future_field", "eq", "x"))],
    ] as const) {
      const id = await segment(`dyn ${name}`, "dynamic", filter);
      expect(await flag(id), name).toEqual({
        care_only: true,
        care_only_reason: "clinical_filter",
      });
    }
    const plain = await segment("dyn plain", "dynamic", f(cond("gender", "eq", "female")));
    expect(await flag(plain)).toEqual({ care_only: false, care_only_reason: null });
    const custom = await segment("dyn custom", "dynamic", f(cond("custom.shoe_size", "eq", "5")));
    expect((await flag(custom)).care_only).toBe(false);
  });

  it("forces the mark even when a browser session writes the segment with care_only = false", async () => {
    const id = await asUser(c, owner, async () =>
      one(
        "insert into public.segments (org_id, name, kind, filter, care_only) values ($1, 'browser dyn', 'dynamic', $2::jsonb, false)",
        [org, JSON.stringify(f(cond("last_visit", "is_not_empty")))],
      ),
    );
    expect((await flag(id)).care_only).toBe(true);
  });

  it("drops an automatic mark when the filter stops using care fields, but keeps a manual one", async () => {
    const auto = await segment("auto", "dynamic", f(cond("lifecycle_stage", "in", ["active"])));
    await svc(() =>
      q("update public.segments set filter = $2::jsonb where id = $1", [
        auto,
        JSON.stringify(f(cond("gender", "eq", "male"))),
      ]),
    );
    expect((await flag(auto)).care_only).toBe(false);

    const manual = await segment("manual dyn", "dynamic", f(cond("gender", "eq", "male")));
    await svc(() =>
      q("select public.segment_set_care_only($1, $2, true, $3, 'manual')", [org, manual, owner]),
    );
    await svc(() =>
      q("update public.segments set filter = $2::jsonb where id = $1", [
        manual,
        JSON.stringify(f(cond("gender", "eq", "female"))),
      ]),
    );
    expect(await flag(manual)).toEqual({ care_only: true, care_only_reason: "manual" });
  });

  it("lets only the server-side function release a care-only mark", async () => {
    const id = await segment("static care", "static", undefined, true);
    // A browser session (RLS lets a manager update the row) cannot clear it.
    await expect(
      asUser(c, owner, () => q("update public.segments set care_only = false where id = $1", [id])),
    ).rejects.toThrow(/administrator/);
    await expect(
      asUser(c, owner, () =>
        q("select public.segment_set_care_only($1, $2, false, $3)", [org, id, owner]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await flag(id)).care_only).toBe(true);
    // The service-role function releases it and records nothing else behind.
    await svc(() => q("select public.segment_set_care_only($1, $2, false, $3)", [org, id, owner]));
    expect(await flag(id)).toEqual({ care_only: false, care_only_reason: null });
    // And marks it again.
    await svc(() =>
      q("select public.segment_set_care_only($1, $2, true, $3, 'filled_from_clinical_filter')", [
        org,
        id,
        owner,
      ]),
    );
    expect(await flag(id)).toEqual({
      care_only: true,
      care_only_reason: "filled_from_clinical_filter",
    });
  });

  it("refuses a segment from another organisation", async () => {
    const id = await segment("mine", "static");
    await expect(
      svc(() =>
        q("select public.segment_set_care_only($1, $2, true, $3)", [otherOrg, id, stranger]),
      ),
    ).rejects.toThrow(/segment not found/);
    const r = await svc(() => q("select public.segment_is_care_only($1, $2) as x", [otherOrg, id]));
    expect(r.rows[0].x).toBe(true); // not found for that org: fail closed
  });

  it("counts a segment as care only when it includes a care-only segment, checked at use time", async () => {
    const base = await segment("inner", "static");
    const outer = await segment("outer", "dynamic", f(cond("segments", "has_any", [base])));
    expect((await flag(outer)).care_only).toBe(false);
    const before = await svc(() =>
      q("select public.segment_is_care_only($1, $2) as x", [org, outer]),
    );
    expect(before.rows[0].x).toBe(false);
    // The inner list is marked later: the outer one is not re-saved, but the use-time check sees it.
    await svc(() => q("select public.segment_set_care_only($1, $2, true, $3)", [org, base, owner]));
    expect((await flag(outer)).care_only).toBe(false);
    const after = await svc(() =>
      q("select public.segment_is_care_only($1, $2) as x", [org, outer]),
    );
    expect(after.rows[0].x).toBe(true);
    // A new segment that includes the care-only one is marked when it is saved.
    const later = await segment("later", "dynamic", f(cond("segments", "has_any", [base])));
    expect((await flag(later)).care_only).toBe(true);
  });

  describe("campaign_snapshot_segment", () => {
    it("refuses a marketing snapshot of a care-only segment, dry run or not", async () => {
      const seg = await segment("snap care", "static", undefined, true);
      const camp = await campaignFor("c1", seg);
      await expect(snapshot(camp, seg, "marketing", true)).rejects.toThrow(/care programmes only/);
      await expect(snapshot(camp, seg, "marketing", false)).rejects.toThrow(/care programmes only/);
      await expect(snapshot(camp, seg, "anything else", true)).rejects.toThrow(
        /care programmes only/,
      );
      const none = await svc(() =>
        q("select count(*)::int as n from public.campaign_recipients where campaign_id = $1", [
          camp,
        ]),
      );
      expect(none.rows[0].n).toBe(0);
    });

    it("needs a segment for marketing, and the campaign's own segment for a real snapshot", async () => {
      const seg = await segment("snap plain", "static");
      const other = await segment("snap other", "static");
      const camp = await campaignFor("c2", seg);
      await expect(snapshot(camp, null, "marketing", true)).rejects.toThrow(/needs a segment/);
      await expect(snapshot(camp, other, "marketing", false)).rejects.toThrow(
        /campaign's own segment/,
      );
      await expect(snapshot(camp, seg, "marketing", false)).resolves.toBeTruthy();
    });

    it("allows a care purpose for a care-only segment", async () => {
      const seg = await segment("snap care ok", "static", undefined, true);
      const camp = await campaignFor("c3", seg);
      const r = await snapshot(camp, seg, "care", true);
      expect(r.rows[0].r.total).toBe(0);
    });

    it("keeps the function away from browser roles", async () => {
      const seg = await segment("snap browser", "static");
      const camp = await campaignFor("c4", seg);
      await expect(
        asUser(c, owner, () =>
          q(
            "select public.campaign_snapshot_segment($1, $2, 'true', '[]'::jsonb, false, 10, true, $3, 'marketing')",
            [org, camp, seg],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("keeps the SQL list of marketing-safe fields equal to the TypeScript registry", async () => {
    const ts = buildContactFieldRegistry({ clinicalAvailable: true })
      .list()
      .filter((x) => !x.clinical && !x.careOnly)
      .map((x) => x.key)
      .sort();
    const { rows } = await q("select unnest(app.marketing_safe_filter_fields()) as k order by 1");
    expect(rows.map((r) => r.k as string).sort()).toEqual(ts);
  });
});
