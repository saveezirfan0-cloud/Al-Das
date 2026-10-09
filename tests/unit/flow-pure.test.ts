import { describe, expect, it } from "vitest";

import { evaluateBranch, matchTriggerConditions } from "@/lib/flow-engine/conditions";
import { hasErrors, nextEdge, validateGraph } from "@/lib/flow-engine/graph";
import { getPath, interpolate } from "@/lib/flow-engine/interpolate";
import { isWithinOfficeHours, officeHoursSchema } from "@/lib/flow-engine/office-hours";
import { checkOutboundUrl, isPrivateAddress } from "@/lib/flow-engine/ssrf";

import { edge, graph, node } from "./flow-fakes";

describe("interpolate", () => {
  const scope = {
    contact: { first_name: "Sara" },
    vars: { CLINIC: "Al Das" },
    steps: { q1: { response: { text: "yes" } } },
    appointment: { starts_at: "2026-10-12T09:30:00.000Z" },
  };

  it("fills contact, workspace variables and step responses", () => {
    const r = interpolate(
      "Hi {contact.first_name} from {vars.CLINIC}: {steps.q1.response.text}",
      scope,
    );
    expect(r.text).toBe("Hi Sara from Al Das: yes");
    expect(r.missing).toEqual([]);
  });

  it("renders unknown paths empty and reports them", () => {
    const r = interpolate("Hi {contact.nickname}!", scope);
    expect(r.text).toBe("Hi !");
    expect(r.missing).toEqual(["contact.nickname"]);
  });

  it("supports default and date filters in the clinic timezone", () => {
    expect(interpolate("{contact.nickname|default:Patient}", scope).text).toBe("Patient");
    expect(
      interpolate('{appointment.starts_at|date:"DD MMM HH:mm"}', scope, { timezone: "Asia/Dubai" })
        .text,
    ).toBe("12 Oct 13:30");
  });

  it("leaves non-token braces alone", () => {
    expect(interpolate('{"a": 1}', scope).text).toBe('{"a": 1}');
  });

  it("getPath handles missing branches", () => {
    expect(getPath(scope, "a.b.c")).toBeUndefined();
    expect(getPath(scope, "contact.first_name")).toBe("Sara");
  });
});

describe("trigger conditions", () => {
  const facts = { source: "Website", keyword: "Check Up please", ad: "12345" };
  it("empty conditions always match", () => {
    expect(matchTriggerConditions(undefined, facts)).toBe(true);
    expect(matchTriggerConditions({ logic: "and", conditions: [] }, facts)).toBe(true);
  });
  it("supports equals / contains / not variants case-insensitively", () => {
    const m = (
      op: "equals" | "not_equals" | "contains" | "not_contains",
      category: "source" | "keyword" | "ad",
      value: string,
    ) => matchTriggerConditions({ logic: "and", conditions: [{ category, op, value }] }, facts);
    expect(m("equals", "source", "website")).toBe(true);
    expect(m("not_equals", "source", "website")).toBe(false);
    expect(m("contains", "keyword", "check up")).toBe(true);
    expect(m("not_contains", "keyword", "vaccine")).toBe(true);
    expect(m("equals", "ad", "999")).toBe(false);
  });
  it("combines with and / or", () => {
    const conditions = [
      { category: "source" as const, op: "equals" as const, value: "website" },
      { category: "ad" as const, op: "equals" as const, value: "nope" },
    ];
    expect(matchTriggerConditions({ logic: "and", conditions }, facts)).toBe(false);
    expect(matchTriggerConditions({ logic: "or", conditions }, facts)).toBe(true);
  });
  it("missing facts compare as empty text", () => {
    expect(
      matchTriggerConditions(
        { logic: "and", conditions: [{ category: "ad", op: "equals", value: "x" }] },
        {},
      ),
    ).toBe(false);
  });
});

describe("branch conditions", () => {
  const scope = { vars: { age: "42", city: "Dubai", blank: " " }, contact: { first_name: "Sara" } };
  it("compares text and numbers", () => {
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "vars.city", op: "eq", right: "dubai" }] },
        scope,
      ),
    ).toBe(true);
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "vars.age", op: "gte", right: "40" }] },
        scope,
      ),
    ).toBe(true);
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "vars.age", op: "lt", right: "40" }] },
        scope,
      ),
    ).toBe(false);
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "vars.city", op: "in", right: "Abu Dhabi, Dubai" }] },
        scope,
      ),
    ).toBe(true);
  });
  it("fails closed on blank / unknown numeric data and empty rules", () => {
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "vars.missing", op: "gt", right: "1" }] },
        scope,
      ),
    ).toBe(false);
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "vars.blank", op: "gt", right: "1" }] },
        scope,
      ),
    ).toBe(false);
    expect(evaluateBranch({ logic: "and", conditions: [] }, scope)).toBe(false);
  });
  it("is_empty treats whitespace as blank", () => {
    expect(
      evaluateBranch({ logic: "and", conditions: [{ left: "vars.blank", op: "is_empty" }] }, scope),
    ).toBe(true);
    expect(
      evaluateBranch(
        { logic: "and", conditions: [{ left: "{contact.first_name}", op: "is_not_empty" }] },
        scope,
      ),
    ).toBe(true);
  });
});

describe("office hours", () => {
  const cfg = officeHoursSchema.parse({
    timezone: "Asia/Dubai",
    schedule: {
      mon: [
        { start: "09:00", end: "13:00" },
        { start: "14:00", end: "18:00" },
      ],
      tue: [{ start: "18:00", end: "09:00" }],
    },
  });
  it("is inside a slot (end exclusive)", () => {
    // 2026-10-12 is a Monday. 10:00 Dubai = 06:00Z.
    expect(isWithinOfficeHours(cfg, new Date("2026-10-12T06:00:00Z"))).toBe(true);
    expect(isWithinOfficeHours(cfg, new Date("2026-10-12T09:00:00Z"))).toBe(false); // 13:00 exactly
    expect(isWithinOfficeHours(cfg, new Date("2026-10-12T09:30:00Z"))).toBe(false); // lunch
  });
  it("uses the schedule timezone for the weekday", () => {
    // Sunday 22:00Z is Monday 02:00 in Dubai; no slot then.
    expect(isWithinOfficeHours(cfg, new Date("2026-10-11T22:00:00Z"))).toBe(false);
  });
  it("ignores misconfigured slots and unlisted days", () => {
    expect(isWithinOfficeHours(cfg, new Date("2026-10-13T08:00:00Z"))).toBe(false); // Tue, end<=start ignored
    expect(isWithinOfficeHours(cfg, new Date("2026-10-14T08:00:00Z"))).toBe(false); // Wed unlisted
  });
});

describe("ssrf guard", () => {
  it("rejects non-https, credentials, localhost and private ranges", () => {
    for (const u of [
      "http://example.com/x",
      "https://user:pw@example.com/",
      "https://localhost/x",
      "https://db.internal/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.1/",
      "https://[::1]/",
      "https://[fd00::1]/",
      "not a url",
    ]) {
      expect(checkOutboundUrl(u).ok, u).toBe(false);
    }
  });
  it("allows public https URLs", () => {
    expect(checkOutboundUrl("https://hooks.example.com/path?q=1").ok).toBe(true);
    expect(checkOutboundUrl("https://8.8.8.8/").ok).toBe(true);
  });
  it("classifies addresses", () => {
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});

describe("graph validation", () => {
  const ok = graph(
    [node("t", "trigger"), node("m", "message", { text: "hi" }), node("e", "end_flow")],
    [edge("t", "m"), edge("m", "e")],
  );

  it("accepts a simple valid graph", () => {
    const r = validateGraph(ok);
    expect(hasErrors(r.issues)).toBe(false);
  });
  it("requires exactly one trigger connected to something", () => {
    expect(hasErrors(validateGraph(graph([node("m", "message")], [])).issues)).toBe(true);
    expect(
      hasErrors(
        validateGraph(graph([node("t", "trigger"), node("t2", "trigger")], [edge("t", "t2")]))
          .issues,
      ),
    ).toBe(true);
    expect(
      hasErrors(validateGraph(graph([node("t", "trigger"), node("m", "message")], [])).issues),
    ).toBe(true);
  });
  it("rejects edges to missing nodes, into the trigger, bad handles and duplicate outputs", () => {
    const base = [node("t", "trigger"), node("m", "message")];
    expect(hasErrors(validateGraph(graph(base, [edge("t", "m"), edge("m", "ghost")])).issues)).toBe(
      true,
    );
    expect(hasErrors(validateGraph(graph(base, [edge("t", "m"), edge("m", "t")])).issues)).toBe(
      true,
    );
    expect(
      hasErrors(validateGraph(graph(base, [edge("t", "m"), edge("m", "t", "true")])).issues),
    ).toBe(true);
    const dup = graph(
      [...base, node("a", "end_flow"), node("b", "end_flow")],
      [edge("t", "m"), edge("m", "a"), edge("m", "b")],
    );
    expect(hasErrors(validateGraph(dup).issues)).toBe(true);
  });
  it("warns about unreachable nodes", () => {
    const g = graph(
      [node("t", "trigger"), node("m", "message"), node("orphan", "end_flow")],
      [edge("t", "m")],
    );
    const r = validateGraph(g);
    expect(r.issues.some((i) => i.level === "warning" && i.nodeId === "orphan")).toBe(true);
  });
  it("enforces question limits and unique option ids", () => {
    const opts4 = ["a", "b", "c", "d"].map((id) => ({ id, title: id }));
    const q = (data: Record<string, unknown>) =>
      validateGraph(
        graph(
          [node("t", "trigger"), node("q", "question", { text: "Pick one", ...data })],
          [edge("t", "q")],
        ),
      );
    expect(hasErrors(q({ style: "buttons", options: opts4 }).issues)).toBe(true);
    expect(hasErrors(q({ style: "list", options: opts4 }).issues)).toBe(false);
    expect(
      hasErrors(
        q({
          style: "buttons",
          options: [
            { id: "a", title: "A" },
            { id: "a", title: "B" },
          ],
        }).issues,
      ),
    ).toBe(true);
  });
  it("accepts option:<id> handles on questions only", () => {
    const g = graph(
      [
        node("t", "trigger"),
        node("q", "question", {
          text: "Book?",
          style: "buttons",
          options: [{ id: "y", title: "Yes" }],
        }),
        node("e", "end_flow"),
      ],
      [edge("t", "q"), edge("q", "e", "option:y")],
    );
    expect(hasErrors(validateGraph(g).issues)).toBe(false);
  });
  it("blocks publishing nodes that still need settings", () => {
    const g = (n: ReturnType<typeof node>) =>
      validateGraph(graph([node("t", "trigger"), n], [edge("t", n.id)])).issues;
    const setup = (n: ReturnType<typeof node>) =>
      g(n).filter((i) => i.kind === "setup" && i.level === "error");
    expect(setup(node("m", "message", { text: "  " }))).toHaveLength(1);
    expect(setup(node("m", "message", { text: "hi" }))).toHaveLength(0);
    expect(setup(node("m", "template", { template_id: "" }))).toHaveLength(1);
    expect(
      setup(node("m", "template", { template_id: "00000000-0000-4000-8000-0000000000a1" })),
    ).toHaveLength(0);
    expect(setup(node("m", "run_flow", {}))).toHaveLength(1);
    expect(setup(node("m", "assign_to", { target: { type: "team", id: "" } }))).toHaveLength(1);
    expect(setup(node("m", "assign_to", { target: { type: "bot" } }))).toHaveLength(0);
    expect(setup(node("m", "wait", { amount: 0, unit: "hours" }))).toHaveLength(1);
    expect(setup(node("m", "branch", { conditions: [] }))).toHaveLength(1);
    expect(setup(node("m", "api_action", { url: "http://x.com" }))).toHaveLength(1);
    expect(setup(node("m", "api_action", { url: "https://x.com/hook" }))).toHaveLength(0);
    expect(
      setup(node("m", "send_notification", { title: "", target: { type: "role", id: "" } })),
    ).toHaveLength(2);
    expect(hasErrors(g(node("m", "message", { text: "" })))).toBe(true);
  });
  it("returns schema errors for malformed input", () => {
    const r = validateGraph({ nodes: [{ id: "x", type: "nope" }], edges: [] });
    expect(r.graph).toBeNull();
    expect(hasErrors(r.issues)).toBe(true);
  });
  it("nextEdge treats a null handle as default", () => {
    expect(nextEdge(ok, "t", "default")?.target).toBe("m");
    expect(nextEdge(ok, "t", "fallback")).toBeUndefined();
  });
});
