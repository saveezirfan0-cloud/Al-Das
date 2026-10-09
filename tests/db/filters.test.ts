/**
 * Runs compiled filters against a real Postgres through contacts_search and
 * checks that the SQL compiler and the in-memory evaluator agree on every case.
 * Fake data only. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, cond, or, type Filter } from "@/lib/filters/ast";
import { evaluateFilter, type ContactRecord } from "@/lib/filters/evaluate";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";
import { compileFilter, compileOrderBy } from "@/lib/filters/to-sql";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const registry = buildContactFieldRegistry({
  customFields: [
    { key: "plan", label: "Plan", type: "select" },
    { key: "visits", label: "Visits", type: "number" },
    { key: "interests", label: "Interests", type: "multi_select" },
    { key: "vip", label: "VIP", type: "boolean" },
    { key: "last_checkup", label: "Last checkup", type: "date" },
  ],
});

type Seed = {
  key: string;
  first: string;
  last: string;
  gender: string | null;
  phone: string | null;
  email: string | null;
  dob: string | null;
  nationality: string | null;
  last_interaction_days_ago: number | null;
  stop_marketing: boolean;
  custom: Record<string, unknown>;
  tags: string[];
  segments: string[];
  mentions: string[]; // user keys
  alt_phones: string[];
};

const SEEDS: Seed[] = [
  {
    key: "a",
    first: "Amina",
    last: "Alpha",
    gender: "female",
    phone: "+971500000001",
    email: "a@example.test",
    dob: "1990-10-10",
    nationality: "AE",
    last_interaction_days_ago: 2,
    stop_marketing: false,
    custom: {
      plan: "axa",
      visits: 4,
      interests: ["derma", "dental"],
      vip: true,
      last_checkup: "2025-01-15",
    },
    tags: ["vip", "derma"],
    segments: ["s1"],
    mentions: ["u1"],
    alt_phones: ["+971500000099"],
  },
  {
    key: "b",
    first: "Bilal",
    last: "Beta",
    gender: "male",
    phone: "+971500000002",
    email: null,
    dob: "1984-02-29",
    nationality: "SA",
    last_interaction_days_ago: 20,
    stop_marketing: true,
    custom: { plan: "mednet", visits: 1, interests: ["gp"] },
    tags: ["derma"],
    segments: [],
    mentions: [],
    alt_phones: [],
  },
  {
    key: "c",
    first: "Chen",
    last: "Gamma",
    gender: null,
    phone: null,
    email: "c@example.test",
    dob: null,
    nationality: null,
    last_interaction_days_ago: 45,
    stop_marketing: false,
    custom: { visits: "7", vip: false },
    tags: [],
    segments: ["s1"],
    mentions: ["u2"],
    alt_phones: [],
  },
  {
    key: "d",
    first: "Dana",
    last: "Delta",
    gender: "female",
    phone: "+971500000004",
    email: "d@example.test",
    dob: "2000-12-25",
    nationality: "ae",
    last_interaction_days_ago: null,
    stop_marketing: false,
    custom: { interests: [] },
    tags: ["vip"],
    segments: [],
    mentions: [],
    alt_phones: ["+971500000002"],
  },
];

describe.skipIf(!TEST_DATABASE_URL)("compiled filters vs evaluator", () => {
  let c: Client;
  let org: string;
  const ids: Record<string, string> = {};
  const tagIds: Record<string, string> = {};
  const segIds: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const records: Record<string, ContactRecord> = {};

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const owner = await createAuthUser(c, "owner@example.test");
    userIds.u1 = owner;
    userIds.u2 = await createAuthUser(c, "u2@example.test");
    org = await createOrg(c, "Org F", "org-f", owner);

    await asServiceRole(c, async () => {
      for (const t of ["vip", "derma"]) {
        const { rows } = await c.query<{ id: string }>(
          "insert into public.tags (org_id, name) values ($1, $2) returning id",
          [org, t],
        );
        tagIds[t] = rows[0].id;
      }
      const { rows: seg } = await c.query<{ id: string }>(
        "insert into public.segments (org_id, name, kind) values ($1, 'Static 1', 'static') returning id",
        [org],
      );
      segIds.s1 = seg[0].id;

      for (const s of SEEDS) {
        const lastInteraction =
          s.last_interaction_days_ago === null
            ? null
            : new Date(Date.now() - s.last_interaction_days_ago * 86_400_000 - 3_600_000);
        const { rows } = await c.query<{ id: string; created_at: string; full_name: string }>(
          `insert into public.contacts (org_id, first_name, last_name, gender, phone_e164, email, dob, nationality, last_interaction_at, stop_marketing, custom)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, created_at, full_name`,
          [
            org,
            s.first,
            s.last,
            s.gender,
            s.phone,
            s.email,
            s.dob,
            s.nationality,
            lastInteraction,
            s.stop_marketing,
            JSON.stringify(s.custom),
          ],
        );
        const id = rows[0].id;
        ids[s.key] = id;
        for (const t of s.tags)
          await c.query(
            "insert into public.contact_tags (org_id, contact_id, tag_id) values ($1, $2, $3)",
            [org, id, tagIds[t]],
          );
        for (const sg of s.segments)
          await c.query(
            "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3)",
            [org, segIds[sg], id],
          );
        for (const u of s.mentions)
          await c.query(
            "insert into public.mentions (org_id, user_id, contact_id) values ($1, $2, $3)",
            [org, userIds[u], id],
          );
        for (const p of s.alt_phones)
          await c.query(
            "insert into public.contact_phones (org_id, contact_id, phone_e164) values ($1, $2, $3)",
            [org, id, p],
          );
        records[s.key] = {
          columns: {
            full_name: rows[0].full_name,
            first_name: s.first,
            last_name: s.last,
            gender: s.gender,
            phone_e164: s.phone,
            email: s.email,
            dob: s.dob,
            nationality: s.nationality,
            last_interaction_at: lastInteraction?.toISOString() ?? null,
            stop_marketing: s.stop_marketing,
            promotions_opt_in: false,
            source: "manual",
            created_at: rows[0].created_at,
            owner_id: null,
          },
          custom: s.custom,
          relations: {
            contact_tags: s.tags.map((t) => ({ tag_id: tagIds[t] })),
            segment_members: s.segments.map((sg) => ({ segment_id: segIds[sg] })),
            mentions: s.mentions.map((u) => ({ user_id: userIds[u] })),
            contact_phones: s.alt_phones.map((p) => ({ phone_e164: p })),
          },
        };
      }
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  async function search(filter: Filter | null, orderBy = "c.created_at desc"): Promise<string[]> {
    const { sql, params } = compileFilter(filter, registry, { timezone: "Asia/Dubai" });
    return asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.contacts_search($1, $2, $3::jsonb, $4, 100, 0)",
        [org, sql, JSON.stringify(params), orderBy],
      );
      return rows.map((r) => r.id);
    });
  }

  function expected(filter: Filter | null): string[] {
    return SEEDS.filter((s) =>
      evaluateFilter(filter, registry, records[s.key], { timezone: "Asia/Dubai" }),
    ).map((s) => ids[s.key]);
  }

  const cases: Array<[string, Filter | null]> = [
    ["empty", null],
    ["name contains", { include: and(cond("full_name", "contains", "a")) }],
    ["name eq ci", { include: and(cond("full_name", "eq", "amina alpha")) }],
    ["gender in", { include: and(cond("gender", "in", ["female", "other"])) }],
    ["gender neq (nulls match)", { include: and(cond("gender", "neq", "female")) }],
    ["gender not_in", { include: and(cond("gender", "not_in", ["female"])) }],
    ["gender empty", { include: and(cond("gender", "is_empty")) }],
    ["nationality ci in", { include: and(cond("nationality", "in", ["AE"])) }],
    ["phone starts", { include: and(cond("phone", "starts_with", "+97150")) }],
    ["phone empty", { include: and(cond("phone", "is_empty")) }],
    ["email ends", { include: and(cond("email", "ends_with", ".test")) }],
    ["email not_contains", { include: and(cond("email", "not_contains", "a@")) }],
    ["interacted < 7d", { include: and(cond("last_interaction_at", "within_last", 7)) }],
    ["interacted < 30d", { include: and(cond("last_interaction_at", "within_last", 30)) }],
    ["interacted > 30d", { include: and(cond("last_interaction_at", "older_than", 30)) }],
    ["not within 30d", { include: and(cond("last_interaction_at", "not_within_last", 30)) }],
    ["never interacted", { include: and(cond("last_interaction_at", "is_empty")) }],
    [
      "dob between",
      { include: and(cond("dob", "between", { from: "1980-01-01", to: "1995-12-31" })) },
    ],
    ["dob before", { include: and(cond("dob", "before", "1990-10-10")) }],
    ["dob after", { include: and(cond("dob", "after", "1990-10-10")) }],
    ["dob on", { include: and(cond("dob", "on", "2000-12-25")) }],
    ["birthday month", { include: and(cond("birthday", "month_is", 2)) }],
    ["birthday within year", { include: and(cond("birthday", "within_next", 366)) }],
    [
      "birthday none in 0 days (unless today)",
      { include: and(cond("birthday", "within_next", 0)) },
    ],
    ["stop marketing", { include: and(cond("stop_marketing", "is_true")) }],
    ["custom plan eq", { include: and(cond("custom.plan", "eq", "axa")) }],
    ["custom plan in", { include: and(cond("custom.plan", "in", ["axa", "mednet"])) }],
    ["custom plan empty", { include: and(cond("custom.plan", "is_empty")) }],
    ["custom visits gte 2 (string ignored)", { include: and(cond("custom.visits", "gte", 2)) }],
    ["custom visits empty", { include: and(cond("custom.visits", "is_empty")) }],
    [
      "custom interests any",
      { include: and(cond("custom.interests", "has_any", ["gp", "dental"])) },
    ],
    [
      "custom interests all",
      { include: and(cond("custom.interests", "has_all", ["derma", "dental"])) },
    ],
    ["custom interests none", { include: and(cond("custom.interests", "has_none", ["derma"])) }],
    ["custom interests empty", { include: and(cond("custom.interests", "is_empty")) }],
    ["custom vip true", { include: and(cond("custom.vip", "is_true")) }],
    ["custom vip false", { include: and(cond("custom.vip", "is_false")) }],
    ["custom date older", { include: and(cond("custom.last_checkup", "older_than", 30)) }],
    ["tags any", { include: and(cond("tags", "has_any", ["__vip"])) }],
    ["tags all", { include: and(cond("tags", "has_all", ["__vip", "__derma"])) }],
    ["tags none", { include: and(cond("tags", "has_none", ["__derma"])) }],
    ["tags empty", { include: and(cond("tags", "is_empty")) }],
    ["segments any", { include: and(cond("segments", "has_any", ["__s1"])) }],
    ["mentioned u1", { include: and(cond("mentioned_user", "eq", "__u1")) }],
    ["mentioned not u1", { include: and(cond("mentioned_user", "neq", "__u1")) }],
    ["mentions empty", { include: and(cond("mentioned_user", "is_empty")) }],
    ["alt phone", { include: and(cond("alternate_phone", "contains", "0002")) }],
    [
      "or group",
      { include: and(or(cond("gender", "eq", "male"), cond("custom.plan", "eq", "axa"))) },
    ],
    [
      "nested with exclusion",
      {
        include: and(
          cond("full_name", "is_not_empty"),
          or(cond("tags", "has_any", ["__vip"]), cond("segments", "has_any", ["__s1"])),
        ),
        exclude: and(cond("stop_marketing", "is_true"), cond("gender", "eq", "female")),
      },
    ],
    ["exclusion only", { include: and(), exclude: and(cond("tags", "has_any", ["__derma"])) }],
  ];

  function resolve(filter: Filter | null): Filter | null {
    if (!filter) return null;
    const map: Record<string, string> = { __vip: "", __derma: "", __s1: "", __u1: "" };
    map.__vip = tagIds.vip;
    map.__derma = tagIds.derma;
    map.__s1 = segIds.s1;
    map.__u1 = userIds.u1;
    const walk = (n: unknown): unknown => {
      if (Array.isArray(n)) return n.map(walk);
      if (n && typeof n === "object")
        return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
      if (typeof n === "string" && n in map) return map[n];
      return n;
    };
    return walk(filter) as Filter;
  }

  for (const [name, filter] of cases) {
    it(`agrees on: ${name}`, async () => {
      const f = resolve(filter);
      const got = (await search(f)).sort();
      const want = expected(f).sort();
      expect(got).toEqual(want);
    });
  }

  it("sorts by registry fields and reports the total", async () => {
    const orderBy = compileOrderBy([{ field: "full_name", dir: "asc" }], registry);
    const sorted = await search(null, orderBy);
    expect(sorted).toEqual([ids.a, ids.b, ids.c, ids.d]);
    const { rows } = await asServiceRole(c, () =>
      c.query(
        "select total from public.contacts_search($1, 'true', '[]'::jsonb, 'c.created_at desc', 2, 0)",
        [org],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].total)).toBe(4);
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "select * from public.contacts_search($1, 'true', '[]'::jsonb, 'c.created_at desc; drop table contacts', 2, 0)",
          [org],
        ),
      ).rejects.toThrow(/invalid order by/);
    });
  });

  it("contacts_count and contacts_ids use the same predicate", async () => {
    const { sql, params } = compileFilter(
      { include: and(cond("gender", "eq", "female")) },
      registry,
    );
    await asServiceRole(c, async () => {
      const { rows } = await c.query("select public.contacts_count($1, $2, $3::jsonb) as n", [
        org,
        sql,
        JSON.stringify(params),
      ]);
      expect(Number(rows[0].n)).toBe(2);
      const { rows: idRows } = await c.query(
        "select * from public.contacts_ids($1, $2, $3::jsonb, 10)",
        [org, sql, JSON.stringify(params)],
      );
      expect(idRows.map((r) => r.contacts_ids).sort()).toEqual([ids.a, ids.d].sort());
    });
  });

  it("the search RPCs are not callable by authenticated users", async () => {
    await c.query("set role authenticated");
    try {
      await expect(
        c.query("select * from public.contacts_search($1, 'true', '[]'::jsonb)", [org]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("reset role");
    }
  });
});
