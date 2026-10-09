import { describe, expect, it } from "vitest";

import {
  formatDate,
  getPath,
  interpolate,
  missingPaths,
  references,
  toDateFnsPattern,
} from "@/lib/flow-engine/interpolate";

const scope = {
  contact: { first_name: "Sara", last_name: null },
  appointment: { starts_at: "2026-10-14T06:30:00Z", doctor: "Dr. Test" },
  vars: { plan: "gold", n: 3 },
  steps: { "node-1": { response: { name: "X", list: [{ a: "first" }] } } },
  nested: { obj: { deep: 1 } },
};

describe("interpolate", () => {
  it("fills contact, vars and step paths", () => {
    expect(interpolate("Hi {contact.first_name}, plan {vars.plan} #{vars.n}", scope)).toBe(
      "Hi Sara, plan gold #3",
    );
    expect(interpolate("{steps.node-1.response.name}", scope)).toBe("X");
    expect(interpolate("{steps.node-1.response.list.0.a}", scope)).toBe("first");
  });

  it("renders unknown, null and object paths as empty (never JSON)", () => {
    expect(interpolate("[{contact.last_name}][{contact.nope}][{nested.obj}]", scope)).toBe(
      "[][][]",
    );
  });

  it("formats dates in the org time zone with day.js style tokens", () => {
    expect(interpolate('{appointment.starts_at|date:"DD MMM HH:mm"}', scope)).toBe("14 Oct 10:30");
    expect(interpolate('{appointment.starts_at|date:"dddd D MMMM YYYY, h:mm A"}', scope)).toBe(
      "Wednesday 14 October 2026, 10:30 AM",
    );
    expect(interpolate('{appointment.starts_at|date:"HH:mm"}', scope, { timezone: "UTC" })).toBe(
      "06:30",
    );
  });

  it("returns empty for invalid dates", () => {
    expect(formatDate("not a date", "YYYY", "UTC")).toBe("");
    expect(interpolate('{contact.last_name|date:"YYYY"}', scope)).toBe("");
  });

  it("supports default, upper, lower, trim", () => {
    expect(interpolate('{contact.last_name|default:"there"}', scope)).toBe("there");
    expect(interpolate("{contact.first_name|upper}", scope)).toBe("SARA");
    expect(interpolate("{contact.first_name|lower}", scope)).toBe("sara");
  });

  it("leaves JSON, template placeholders and plain braces alone", () => {
    expect(interpolate('{"a": 1} {{1}} {} { x }', scope)).toBe('{"a": 1} {{1}} {} { x }');
  });

  it("quotes literal letters in date patterns", () => {
    expect(toDateFnsPattern("D/M/YY at HH:mm")).toBe("d/M/yy 'at' HH:mm");
    expect(interpolate('{appointment.starts_at|date:"D/M/YY at HH:mm"}', scope)).toBe(
      "14/10/26 at 10:30",
    );
    expect(interpolate('{appointment.starts_at|date:"D MMM \'x"}', scope)).toBe("14 Oct 'x");
  });

  it("reports references and missing paths", () => {
    expect(references('Hi {contact.first_name|upper} {vars.x|default:"y"}')).toEqual([
      { path: "contact.first_name", filters: ["upper"] },
      { path: "vars.x", filters: ["default"] },
    ]);
    expect(missingPaths('{contact.first_name} {vars.zzz} {vars.q|default:"a"}', scope)).toEqual([
      "vars.zzz",
    ]);
  });

  it("getPath walks arrays and refuses non-objects", () => {
    expect(getPath(scope, "steps.node-1.response.list.0.a")).toBe("first");
    expect(getPath(scope, "contact.first_name.length")).toBeUndefined();
    expect(getPath(scope, "steps.node-1.response.list.x")).toBeUndefined();
  });
});
