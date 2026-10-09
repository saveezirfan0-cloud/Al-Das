import { describe, expect, it } from "vitest";

import { mergeEnquiryCustom } from "@/lib/enquiries/custom";
import { buildEnquiryFieldRegistry } from "@/lib/enquiries/registry";
import { and, cond } from "@/lib/filters/ast";
import { UnknownFieldError } from "@/lib/filters/field-registry";
import { ParamBag, compileFilter, compileOrderBy } from "@/lib/filters/to-sql";

const registry = buildEnquiryFieldRegistry({
  customFields: [
    { key: "insurer", label: "Insurer", type: "select", options: [{ value: "axa", label: "AXA" }] },
    { key: "visits", label: "Visits", type: "number" },
  ],
});

const compile = (node: Parameters<typeof cond>[0] extends string ? ReturnType<typeof cond> : never) =>
  compileFilter({ include: and(node) }, registry, { alias: "e" }, new ParamBag());

describe("enquiry filter registry", () => {
  it("compiles columns over alias e with bound values", () => {
    const { sql, params } = compile(cond("status", "in", ["lost", "disqualified"]));
    expect(sql).toContain("e.status");
    expect(sql).not.toContain("lost");
    expect(params).toEqual([["lost", "disqualified"]]);
  });

  it("supports the Open / Closed switch as a status filter", () => {
    expect(compile(cond("status", "eq", "open")).sql).toContain("e.status");
    expect(compile(cond("status", "neq", "open")).sql).toContain("e.status");
  });

  it("joins the open-task count on enquiry_id, not contact_id", () => {
    const { sql } = compile(cond("open_task_count", "gte", 1));
    expect(sql).toContain("public.tasks");
    expect(sql).toContain("enquiry_id");
    expect(sql).toContain("e.id");
    expect(sql).toContain("r.done = false");
    expect(sql).not.toContain("contact_id");
  });

  it("reads custom fields from e.custom", () => {
    expect(compile(cond("custom.insurer", "eq", "axa")).sql).toContain("e.custom");
  });

  it("rejects fields that are not registered (no SQL injection through keys)", () => {
    expect(() => compile(cond("status; drop table enquiries", "eq", "x"))).toThrow(UnknownFieldError);
    expect(() => compile(cond("full_name", "eq", "x"))).toThrow(UnknownFieldError);
  });

  it("builds an ORDER BY the RPC allow-list accepts", () => {
    const order = compileOrderBy(
      [
        { field: "created_at", dir: "desc" },
        { field: "open_task_count", dir: "asc" },
        { field: "custom.visits", dir: "desc" },
      ],
      registry,
      { alias: "e" },
    );
    expect(order).toMatch(/^[A-Za-z0-9_.(),'%>=:* \-]+$/);
    expect(order).not.toContain(";");
    expect(() => compileOrderBy([{ field: "title; x", dir: "asc" }], registry, { alias: "e" })).toThrow();
  });
});

describe("mergeEnquiryCustom", () => {
  const defs = [
    { key: "insurer", label: "Insurer", type: "select" as const, options: [{ value: "axa", label: "AXA" }], required: false },
    { key: "visits", label: "Visits", type: "number" as const, options: [], required: false },
    { key: "ref", label: "Ref", type: "text" as const, options: [], required: true },
  ];

  it("coerces, merges over existing values and removes blanks", () => {
    const res = mergeEnquiryCustom(defs, { visits: 2, insurer: "axa", ref: "A1" }, { visits: "3", insurer: "" });
    expect(res).toEqual({ ok: true, value: { visits: 3, ref: "A1" } });
  });

  it("drops keys without a definition", () => {
    const res = mergeEnquiryCustom(defs, { stale: 1, ref: "A1" }, {});
    expect(res).toEqual({ ok: true, value: { ref: "A1" } });
  });

  it("reports the first invalid value, and required blanks", () => {
    expect(mergeEnquiryCustom(defs, {}, { visits: "abc", ref: "x" })).toMatchObject({ ok: false });
    expect(mergeEnquiryCustom(defs, { ref: "A1" }, { ref: "" })).toMatchObject({ ok: false });
    expect(mergeEnquiryCustom(defs, {}, { insurer: "bupa", ref: "x" })).toMatchObject({ ok: false });
  });
});
