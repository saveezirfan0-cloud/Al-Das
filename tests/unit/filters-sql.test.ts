import { describe, expect, it } from "vitest";

import { and, cond, or, type Filter } from "@/lib/filters/ast";
import {
  buildContactFieldRegistry,
  InvalidOperatorError,
  UnknownFieldError,
} from "@/lib/filters/field-registry";
import {
  compileFilter,
  compileOrderBy,
  escapeLike,
  FilterCompileError,
  ParamBag,
} from "@/lib/filters/to-sql";

const registry = buildContactFieldRegistry({
  customFields: [
    { key: "plan", label: "Plan", type: "select" },
    { key: "visits", label: "Visits", type: "number" },
    { key: "interests", label: "Interests", type: "multi_select" },
    { key: "last_checkup", label: "Last checkup", type: "date" },
    { key: "vip", label: "VIP", type: "boolean" },
  ],
  availableRelations: [
    "contact_tags",
    "segment_members",
    "contact_phones",
    "mentions",
    "enquiries",
  ],
});

const include = (...nodes: Parameters<typeof and>) => ({ include: and(...nodes) });

describe("filter → SQL compiler", () => {
  it("compiles an empty filter to true", () => {
    expect(compileFilter(null, registry)).toEqual({ sql: "true", params: [] });
    expect(compileFilter({ include: and() }, registry).sql).toBe("true");
    expect(compileFilter({ include: and(or(), and()) }, registry).sql).toBe("true");
  });

  it("never puts values in the SQL text and numbers params from 0", () => {
    const { sql, params } = compileFilter(
      include(cond("full_name", "contains", "O'Brien%"), cond("gender", "eq", "female")),
      registry,
    );
    expect(sql).not.toContain("Brien");
    expect(sql).not.toContain("female");
    expect(sql).toBe("(c.full_name ilike ($1 ->> 0) escape '\\' and c.gender = ($1 ->> 1))");
    expect(params).toEqual(["%O'Brien\\%%", "female"]);
  });

  it("escapes LIKE wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("compiles nested and/or groups and the exclusion group", () => {
    const f: Filter = {
      include: and(
        cond("gender", "eq", "female"),
        or(cond("nationality", "eq", "AE"), cond("country", "in", ["AE", "SA"])),
      ),
      exclude: and(cond("stop_marketing", "is_true")),
    };
    const { sql, params } = compileFilter(f, registry);
    expect(sql).toBe(
      "(c.gender = ($1 ->> 0) and (lower(c.nationality) = lower(($1 ->> 1)) or lower(c.country) in (select lower(x) from jsonb_array_elements_text(($1 -> 2)) as x))) and not (c.stop_marketing is true)",
    );
    expect(params).toEqual(["female", "AE", ["AE", "SA"]]);
  });

  it("compiles date operators with the org timezone", () => {
    const { sql, params } = compileFilter(
      include(
        cond("last_interaction_at", "within_last", 7),
        cond("last_interaction_at", "older_than", 30),
        cond("created_at", "on", "2026-10-01"),
        cond("dob", "between", { from: "1990-01-01", to: "1999-12-31" }),
        cond("dob", "before", "2000-01-01"),
      ),
      registry,
      { timezone: "Asia/Dubai" },
    );
    expect(sql).toContain(
      "c.last_interaction_at >= now() - make_interval(days => ($1 ->> 0)::int)",
    );
    expect(sql).toContain("c.last_interaction_at < now() - make_interval(days => ($1 ->> 1)::int)");
    expect(sql).toContain("(c.created_at at time zone ($1 ->> 2))::date = ($1 ->> 3)::date");
    expect(sql).toContain("(c.dob >= ($1 ->> 4)::date and c.dob <= ($1 ->> 5)::date)");
    expect(sql).toContain("c.dob < ($1 ->> 6)::date");
    expect(params).toEqual([
      "7",
      "30",
      "Asia/Dubai",
      "2026-10-01",
      "1990-01-01",
      "1999-12-31",
      "2000-01-01",
    ]);
  });

  it("compiles birthday (anniversary) operators", () => {
    const { sql } = compileFilter(
      include(
        cond("birthday", "within_next", 14),
        cond("birthday", "month_is", 3),
        cond("birthday", "is_today"),
      ),
      registry,
    );
    expect(sql).toContain(
      "app.next_anniversary(c.dob, (now() at time zone ($1 ->> 0))::date) <= (now() at time zone ($1 ->> 0))::date + ($1 ->> 1)::int",
    );
    expect(sql).toContain("extract(month from c.dob) = ($1 ->> 3)::int");
    expect(sql).toContain(
      "app.next_anniversary(c.dob, (now() at time zone ($1 ->> 4))::date) = (now() at time zone ($1 ->> 4))::date",
    );
  });

  it("compiles custom fields with jsonb type guards", () => {
    const { sql, params } = compileFilter(
      include(
        cond("custom.plan", "eq", "axa"),
        cond("custom.visits", "gte", 3),
        cond("custom.interests", "has_any", ["derma", "dental"]),
        cond("custom.interests", "has_all", ["derma"]),
        cond("custom.last_checkup", "older_than", 365),
        cond("custom.vip", "is_true"),
        cond("custom.plan", "is_empty"),
      ),
      registry,
    );
    expect(sql).toContain("(c.custom ->> ($1 ->> 0)) = ($1 ->> 1)");
    expect(sql).toContain(
      "(case when jsonb_typeof(c.custom -> ($1 ->> 2)) = 'number' then (c.custom ->> ($1 ->> 2))::numeric end) >= ($1 ->> 3)::numeric",
    );
    expect(sql).toContain(
      "exists (select 1 from jsonb_array_elements_text((case when jsonb_typeof(c.custom -> ($1 ->> 4)) = 'array' then c.custom -> ($1 ->> 4) else '[]'::jsonb end)) as v where v in (select x from jsonb_array_elements_text(($1 -> 5)) as x))",
    );
    expect(sql).toContain("@> ($1 -> 7)");
    expect(sql).toContain("::date end) < current_date - ($1 ->> 9)::int");
    expect(sql).toContain("::boolean end) is true");
    expect(sql).toContain("nullif((c.custom ->> ($1 ->> 11)), '') is null");
    expect(params[0]).toBe("plan");
    expect(params[5]).toEqual(["derma", "dental"]);
  });

  it("compiles set relations (tags, segments) with exists / count", () => {
    const { sql, params } = compileFilter(
      include(
        cond("tags", "has_any", ["t1", "t2"]),
        cond("tags", "has_all", ["t1", "t2", "t1"]),
        cond("segments", "has_none", ["s1"]),
        cond("tags", "is_empty"),
      ),
      registry,
    );
    expect(sql).toContain(
      "exists (select 1 from public.contact_tags r where r.contact_id = c.id and r.tag_id in (select x::uuid from jsonb_array_elements_text(($1 -> 0)) as x))",
    );
    expect(sql).toContain(
      "(select count(distinct r.tag_id) from public.contact_tags r where r.contact_id = c.id and r.tag_id in (select x::uuid from jsonb_array_elements_text(($1 -> 1)) as x)) = ($1 ->> 2)::int",
    );
    expect(params[2]).toBe("2");
    expect(sql).toContain(
      "not exists (select 1 from public.segment_members r where r.contact_id = c.id and r.segment_id in",
    );
    expect(sql).toContain(
      "not exists (select 1 from public.contact_tags r where r.contact_id = c.id)",
    );
  });

  it("compiles scalar related fields and negations as not exists", () => {
    const { sql } = compileFilter(
      include(
        cond("mentioned_user", "eq", "u1"),
        cond("enquiry_status", "neq", "won"),
        cond("enquiry_count", "gte", 2),
        cond("alternate_phone", "contains", "5012"),
      ),
      registry,
    );
    expect(sql).toContain(
      "exists (select 1 from public.mentions r where r.contact_id = c.id and r.user_id = ($1 ->> 0)::uuid)",
    );
    expect(sql).toContain(
      "not exists (select 1 from public.enquiries r where r.contact_id = c.id and r.status = ($1 ->> 1))",
    );
    expect(sql).toContain(
      "(select count(*) from public.enquiries r where r.contact_id = c.id) >= ($1 ->> 2)::integer",
    );
    expect(sql).toContain(
      "exists (select 1 from public.contact_phones r where r.contact_id = c.id and r.phone_e164 ilike ($1 ->> 3) escape '\\')",
    );
  });

  it("rejects unknown fields, unavailable fields, wrong operators and bad values", () => {
    expect(() => compileFilter(include(cond("drop_table", "eq", 1)), registry)).toThrow(
      UnknownFieldError,
    );
    expect(() => compileFilter(include(cond("appointment_status", "eq", "x")), registry)).toThrow(
      UnknownFieldError,
    );
    expect(() => compileFilter(include(cond("gender", "contains", "fe")), registry)).toThrow(
      InvalidOperatorError,
    );
    expect(() => compileFilter(include(cond("dob", "within_last", -1)), registry)).toThrow(
      FilterCompileError,
    );
    expect(() => compileFilter(include(cond("custom.visits", "gte", "abc")), registry)).toThrow(
      FilterCompileError,
    );
    expect(() => compileFilter(include(cond("tags", "has_any", { from: 1 })), registry)).toThrow(
      FilterCompileError,
    );
    expect(() => compileFilter(include(cond("birthday", "month_is", 13)), registry)).toThrow(
      FilterCompileError,
    );
    expect(() =>
      compileFilter(include(cond("gender", "eq", "x")), registry, { alias: "c; drop" }),
    ).toThrow(FilterCompileError);
  });

  it("shares a ParamBag across compilations", () => {
    const bag = new ParamBag();
    const a = compileFilter(include(cond("gender", "eq", "female")), registry, {}, bag);
    const b = compileFilter(include(cond("source", "eq", "inbox")), registry, {}, bag);
    expect(a.sql).toBe("c.gender = ($1 ->> 0)");
    expect(b.sql).toBe("c.source = ($1 ->> 1)");
    expect(bag.params).toEqual(["female", "inbox"]);
  });

  it("compiles ORDER BY only from registered sortable fields", () => {
    expect(compileOrderBy(null, registry)).toBe("c.created_at desc");
    expect(
      compileOrderBy(
        [
          { field: "full_name", dir: "asc" },
          { field: "custom.visits", dir: "desc" },
        ],
        registry,
      ),
    ).toBe(
      "c.full_name asc nulls last, (case when jsonb_typeof(c.custom -> 'visits') = 'number' then (c.custom ->> 'visits')::numeric end) desc nulls last",
    );
    expect(compileOrderBy([{ field: "enquiry_count", dir: "desc" }], registry)).toBe(
      "(select count(*) from public.enquiries r where r.contact_id = c.id) desc nulls last",
    );
    expect(() => compileOrderBy([{ field: "tags", dir: "asc" }], registry)).toThrow(
      FilterCompileError,
    );
    expect(() => compileOrderBy([{ field: "nope", dir: "asc" }], registry)).toThrow(
      UnknownFieldError,
    );
    // Matches the allow-list enforced by contacts_search
    const re = /^[A-Za-z0-9_.(),'%>=:* \-]+$/;
    expect(re.test(compileOrderBy([{ field: "custom.plan", dir: "asc" }], registry))).toBe(true);
    expect(re.test(compileOrderBy([{ field: "custom.visits", dir: "asc" }], registry))).toBe(true);
    expect(re.test(compileOrderBy([{ field: "enquiry_count", dir: "asc" }], registry))).toBe(true);
  });
});
