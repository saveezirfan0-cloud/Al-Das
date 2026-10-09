import { describe, expect, it } from "vitest";

import {
  computeSlaDueAt,
  resolveSlaMinutes,
  shouldRaiseBreach,
  slaState,
} from "@/lib/enquiries/sla";

const T0 = new Date("2026-10-09T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe("SLA maths", () => {
  it("lets the pipeline override the org default", () => {
    expect(resolveSlaMinutes(5, 60)).toBe(5);
    expect(resolveSlaMinutes(null, 60)).toBe(60);
    expect(resolveSlaMinutes(undefined, null)).toBeNull();
    expect(resolveSlaMinutes(0, null)).toBeNull();
  });

  it("computes the due time or null", () => {
    expect(computeSlaDueAt(T0, 30)?.toISOString()).toBe("2026-10-09T10:30:00.000Z");
    expect(computeSlaDueAt(T0, null)).toBeNull();
    expect(computeSlaDueAt(T0, 0)).toBeNull();
  });
});

describe("slaState", () => {
  const base = {
    status: "open" as const,
    created_at: T0,
    sla_due_at: at(100),
    first_touch_at: null,
  };

  it("walks ok → due_soon → breached", () => {
    expect(slaState(base, at(10))).toBe("ok");
    expect(slaState(base, at(85))).toBe("due_soon");
    expect(slaState(base, at(101))).toBe("breached");
  });

  it("is met when touched in time and breached when touched late", () => {
    expect(slaState({ ...base, first_touch_at: at(50) }, at(500))).toBe("met");
    expect(slaState({ ...base, first_touch_at: at(150) }, at(500))).toBe("breached");
  });

  it("has no live SLA when there is none or the enquiry is closed untouched", () => {
    expect(slaState({ ...base, sla_due_at: null }, at(500))).toBe("none");
    expect(slaState({ ...base, status: "lost" }, at(500))).toBe("none");
  });
});

describe("shouldRaiseBreach", () => {
  const e = {
    status: "open" as const,
    deleted_at: null,
    sla_due_at: at(30),
    first_touch_at: null,
    sla_breached_at: null,
  };

  it("raises once the deadline passes on an untouched open enquiry", () => {
    expect(shouldRaiseBreach(e, at(29))).toBe(false);
    expect(shouldRaiseBreach(e, at(30))).toBe(true);
  });

  it("is idempotent and respects touch, status and deletion", () => {
    expect(shouldRaiseBreach({ ...e, sla_breached_at: at(31) }, at(60))).toBe(false);
    expect(shouldRaiseBreach({ ...e, first_touch_at: at(10) }, at(60))).toBe(false);
    expect(shouldRaiseBreach({ ...e, status: "won" }, at(60))).toBe(false);
    expect(shouldRaiseBreach({ ...e, deleted_at: "2026-10-09T10:05:00Z" }, at(60))).toBe(false);
    expect(shouldRaiseBreach({ ...e, sla_due_at: null }, at(60))).toBe(false);
  });
});
