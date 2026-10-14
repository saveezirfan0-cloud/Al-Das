import { describe, expect, it } from "vitest";

import { can } from "@/lib/auth/can";
import { parseIp } from "@/lib/security/client-ip";
import {
  DEFAULT_FINANCE_ACCESS,
  denyReasonClass,
  describeDays,
  describeWindow,
  financeAccessDecision,
  financeAccessSchema,
  holdsRestrictedArea,
  insideHours,
  isNamedTimeZone,
  localClock,
  readFinanceAccess,
  restrictedAreasFor,
  writeFinanceAccess,
  type FinanceAccessInput,
  type FinanceAccessDecisionInput,
} from "@/lib/security/finance-access";

import fixtures from "./finance/fixtures/finance-access-window.synthetic.json";

// 2026-10-12 is a Monday. Dubai is UTC+4 all year; London changes clocks on 2026-03-29 and 2026-10-25.
const ROLE = "11111111-1111-4111-8111-111111111111";
const OTHER_ROLE = "22222222-2222-4222-8222-222222222222";
const FINANCE = { roleId: ROLE, permissions: ["finance.view", "inbox.send"] };

function settings(patch: FinanceAccessInput = {}) {
  return financeAccessSchema.parse({ enabled: true, ...patch });
}

function decide(
  patch: Partial<FinanceAccessDecisionInput> & { s?: FinanceAccessInput; at?: string } = {},
) {
  const { s, at, ...rest } = patch;
  return financeAccessDecision({
    now: new Date(at ?? "2026-10-12T08:00:00Z"), // Monday 12:00 in Dubai
    timezone: "Asia/Dubai",
    stored: { ok: true, settings: settings(s) },
    ip: parseIp("203.0.113.7"),
    member: FINANCE,
    ...rest,
  });
}

describe("financeAccessSchema", () => {
  it("is off by default, Monday to Saturday 07:00 to 21:00, every finance role, any location", () => {
    expect(DEFAULT_FINANCE_ACCESS).toEqual({
      enabled: false,
      limit_hours: true,
      days: [1, 2, 3, 4, 5, 6],
      start: "07:00",
      end: "21:00",
      ip_allowlist: [],
      scope: "finance_roles",
      role_ids: [],
    });
  });

  it("canonicalises the address list and the days", () => {
    const s = financeAccessSchema.parse({
      days: [3, 1, 1],
      ip_allowlist: [
        " 203.0.113.9/24 ",
        "",
        "203.0.113.0/24",
        "2001:DB8::/32",
        "::ffff:198.51.100.1",
      ],
    });
    expect(s.days).toEqual([1, 3]);
    expect(s.ip_allowlist).toEqual(["203.0.113.0/24", "2001:db8::/32", "198.51.100.1"]);
  });

  it("refuses bad addresses, times, days and empty selections", () => {
    const bad: FinanceAccessInput[] = [
      { ip_allowlist: ["203.0.113.0/40"] },
      { ip_allowlist: ["office"] },
      { ip_allowlist: ["0.0.0.0/0"] },
      { ip_allowlist: Array.from({ length: 51 }, (_, i) => `198.51.100.${i}`) },
      { start: "7:00" },
      { end: "24:00" },
      { days: [0] },
      { days: [8] },
      { enabled: true, days: [] },
      { enabled: true, scope: "selected_roles", role_ids: [] },
      { role_ids: ["not-a-uuid"] },
      { enabled: true, limit_hours: false, ip_allowlist: [] },
    ];
    for (const input of bad)
      expect(financeAccessSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it("allows an address-only window with no days", () => {
    const s = financeAccessSchema.parse({
      enabled: true,
      limit_hours: false,
      days: [],
      ip_allowlist: ["203.0.113.0/24"],
    });
    expect(s.days).toEqual([]);
  });
});

describe("readFinanceAccess / writeFinanceAccess", () => {
  it("defaults when nothing is stored", () => {
    expect(readFinanceAccess(null)).toEqual({ ok: true, settings: DEFAULT_FINANCE_ACCESS });
    expect(readFinanceAccess({})).toEqual({ ok: true, settings: DEFAULT_FINANCE_ACCESS });
    expect(readFinanceAccess([])).toEqual({ ok: true, settings: DEFAULT_FINANCE_ACCESS });
  });

  it("reports a stored value that does not validate (the decision then fails closed)", () => {
    expect(readFinanceAccess({ finance_access: { enabled: "yes" } })).toEqual({
      ok: false,
      settings: null,
      disabled: false,
    });
    expect(readFinanceAccess({ finance_access: { ip_allowlist: ["nope"] } }).ok).toBe(false);
  });

  it("keeps every other org setting when writing", () => {
    const next = writeFinanceAccess({ security: { dormant_days: 10 }, help: { a: 1 } }, settings());
    expect(next.security).toEqual({ dormant_days: 10 });
    expect(next.help).toEqual({ a: 1 });
    expect(readFinanceAccess(next)).toEqual({ ok: true, settings: settings() });
  });
});

describe("holdsRestrictedArea", () => {
  it("spots finance, accounting and wildcard-area permissions, never Admin", () => {
    expect(holdsRestrictedArea(["finance.view"])).toBe(true);
    expect(holdsRestrictedArea(["accounting.journals.view"])).toBe(true);
    expect(holdsRestrictedArea(["finance.*"])).toBe(true);
    expect(holdsRestrictedArea(["*.view"])).toBe(true);
    expect(holdsRestrictedArea(["inbox.send", "contacts.view"])).toBe(false);
    expect(holdsRestrictedArea(["*"])).toBe(false);
    expect(holdsRestrictedArea([])).toBe(false);
  });
});

describe("financeAccessDecision", () => {
  it("never restricts Admin, even with an unreadable setting or outside everything", () => {
    const admin = { roleId: ROLE, permissions: ["*"] };
    expect(
      decide({
        member: admin,
        at: "2026-10-18T22:00:00Z",
        ip: null,
        s: { ip_allowlist: ["198.51.100.0/24"] },
      }),
    ).toEqual({
      allowed: true,
      reason: "admin",
    });
    expect(
      financeAccessDecision({
        now: new Date(),
        timezone: "Asia/Dubai",
        stored: { ok: false, settings: null, disabled: false },
        ip: null,
        member: admin,
      }),
    ).toEqual({ allowed: true, reason: "admin" });
  });

  it("leaves members without finance or accounting permissions alone", () => {
    expect(
      decide({ member: { roleId: ROLE, permissions: ["inbox.send"] }, at: "2026-10-18T22:00:00Z" }),
    ).toEqual({
      allowed: true,
      reason: "not_in_scope",
    });
  });

  it("does nothing while switched off", () => {
    expect(decide({ s: { enabled: false }, at: "2026-10-18T22:00:00Z", ip: null })).toEqual({
      allowed: true,
      reason: "off",
    });
  });

  it("fails closed on an unreadable setting", () => {
    expect(
      financeAccessDecision({
        now: new Date("2026-10-12T08:00:00Z"),
        timezone: "Asia/Dubai",
        stored: { ok: false, settings: null, disabled: false },
        ip: parseIp("203.0.113.7"),
        member: FINANCE,
      }),
    ).toEqual({ allowed: false, reason: "invalid_settings" });
  });

  it("fails closed on an invalid timezone when hours are limited", () => {
    expect(decide({ timezone: "Not/AZone" })).toEqual({
      allowed: false,
      reason: "invalid_settings",
    });
    expect(
      decide({
        timezone: "Not/AZone",
        s: { limit_hours: false, ip_allowlist: ["203.0.113.0/24"] },
      }),
    ).toEqual({
      allowed: true,
      reason: "inside",
    });
  });

  it("applies to every finance role by default and only to listed roles when chosen", () => {
    const night = "2026-10-12T20:00:00Z"; // Tuesday 00:00 Dubai
    expect(decide({ at: night })).toEqual({ allowed: false, reason: "outside_hours" });
    expect(decide({ at: night, s: { scope: "selected_roles", role_ids: [OTHER_ROLE] } })).toEqual({
      allowed: true,
      reason: "not_in_scope",
    });
    expect(decide({ at: night, s: { scope: "selected_roles", role_ids: [ROLE] } })).toEqual({
      allowed: false,
      reason: "outside_hours",
    });
  });

  it("checks the hour boundaries in the org timezone (start inclusive, end exclusive)", () => {
    expect(decide({ at: "2026-10-12T02:59:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    }); // 06:59
    expect(decide({ at: "2026-10-12T03:00:00Z" })).toEqual({ allowed: true, reason: "inside" }); // 07:00
    expect(decide({ at: "2026-10-12T16:59:00Z" })).toEqual({ allowed: true, reason: "inside" }); // 20:59
    expect(decide({ at: "2026-10-12T17:00:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    }); // 21:00
  });

  it("refuses a day that is not allowed", () => {
    expect(decide({ at: "2026-10-18T08:00:00Z" })).toEqual({
      allowed: false,
      reason: "day_not_allowed",
    }); // Sunday noon
    // Saturday 23:30 UTC is already Sunday 03:30 in Dubai
    expect(decide({ at: "2026-10-17T23:30:00Z", s: { start: "00:00", end: "23:59" } })).toEqual({
      allowed: false,
      reason: "day_not_allowed",
    });
  });

  it("follows daylight saving time in the org timezone", () => {
    const london = {
      timezone: "Europe/London",
      s: { days: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "18:00" },
    };
    // before the March change 07:30 UTC is 07:30 local; after it, 08:30 local
    expect(decide({ ...london, at: "2026-03-28T07:30:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    });
    expect(decide({ ...london, at: "2026-03-30T07:30:00Z" })).toEqual({
      allowed: true,
      reason: "inside",
    });
    // 17:30 UTC is 18:30 BST (closed) before the October change and 17:30 GMT (open) after it
    expect(decide({ ...london, at: "2026-10-24T17:30:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    });
    expect(decide({ ...london, at: "2026-10-26T17:30:00Z" })).toEqual({
      allowed: true,
      reason: "inside",
    });
  });

  it("handles overnight windows as belonging to the day they start", () => {
    const night = { s: { days: [1], start: "22:00", end: "02:00" } }; // Monday night only
    expect(decide({ ...night, at: "2026-10-12T18:30:00Z" })).toEqual({
      allowed: true,
      reason: "inside",
    }); // Mon 22:30
    expect(decide({ ...night, at: "2026-10-12T21:30:00Z" })).toEqual({
      allowed: true,
      reason: "inside",
    }); // Tue 01:30
    expect(decide({ ...night, at: "2026-10-12T22:00:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    }); // Tue 02:00
    expect(decide({ ...night, at: "2026-10-13T18:30:00Z" })).toEqual({
      allowed: false,
      reason: "day_not_allowed",
    }); // Tue 22:30
    expect(decide({ ...night, at: "2026-10-12T08:00:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    }); // Mon noon
    expect(decide({ ...night, at: "2026-10-11T21:30:00Z" })).toEqual({
      allowed: false,
      reason: "day_not_allowed",
    }); // Mon 01:30 (Sunday's night)
  });

  it("treats start = end as the whole of each allowed day", () => {
    const allDay = { s: { days: [1], start: "00:00", end: "00:00" } };
    expect(decide({ ...allDay, at: "2026-10-11T20:00:00Z" })).toEqual({
      allowed: true,
      reason: "inside",
    }); // Mon 00:00
    expect(decide({ ...allDay, at: "2026-10-12T19:59:00Z" })).toEqual({
      allowed: true,
      reason: "inside",
    }); // Mon 23:59
    expect(decide({ ...allDay, at: "2026-10-12T20:00:00Z" })).toEqual({
      allowed: false,
      reason: "day_not_allowed",
    }); // Tue
  });

  it("checks the address list, v4 and v6, and fails closed on a missing address only when a list is set", () => {
    const list = { s: { ip_allowlist: ["203.0.113.0/24", "2001:db8:abcd::/48"] } };
    expect(decide({ ...list, ip: parseIp("203.0.113.200") })).toEqual({
      allowed: true,
      reason: "inside",
    });
    expect(decide({ ...list, ip: parseIp("2001:db8:abcd:1::5") })).toEqual({
      allowed: true,
      reason: "inside",
    });
    expect(decide({ ...list, ip: parseIp("::ffff:203.0.113.9") })).toEqual({
      allowed: true,
      reason: "inside",
    });
    expect(decide({ ...list, ip: parseIp("198.51.100.1") })).toEqual({
      allowed: false,
      reason: "ip_not_allowed",
    });
    expect(decide({ ...list, ip: parseIp("2001:db8:abce::1") })).toEqual({
      allowed: false,
      reason: "ip_not_allowed",
    });
    expect(decide({ ...list, ip: null })).toEqual({ allowed: false, reason: "ip_unknown" });
    // no list: a missing address does not matter
    expect(decide({ ip: null })).toEqual({ allowed: true, reason: "inside" });
  });

  it("needs both the address and the hours when both are set", () => {
    const both = { s: { ip_allowlist: ["203.0.113.0/24"] } };
    expect(decide({ ...both, at: "2026-10-12T20:00:00Z" })).toEqual({
      allowed: false,
      reason: "outside_hours",
    });
    expect(decide({ ...both, ip: parseIp("198.51.100.1") })).toEqual({
      allowed: false,
      reason: "ip_not_allowed",
    });
    // address only: any time
    expect(
      decide({
        s: { limit_hours: false, ip_allowlist: ["203.0.113.0/24"] },
        at: "2026-10-18T22:00:00Z",
      }),
    ).toEqual({
      allowed: true,
      reason: "inside",
    });
  });
});

describe("restrictedAreasFor + can()", () => {
  it("takes away finance and accounting only, and only when denied", () => {
    const member = {
      userId: "u",
      orgId: "o",
      roleId: ROLE,
      status: "active" as const,
      permissions: ["finance.*", "accounting.journals.view", "inbox.send", "*.view"],
    };
    const denied = {
      ...member,
      restrictedAreas: restrictedAreasFor({ allowed: false, reason: "outside_hours" }),
    };
    expect(can(denied, "finance.view")).toBe(false);
    expect(can(denied, "finance.bank.manage")).toBe(false);
    expect(can(denied, "accounting.journals.view")).toBe(false);
    expect(can(denied, "inbox.send")).toBe(true);
    expect(can(denied, "contacts.view")).toBe(true);
    const allowed = {
      ...member,
      restrictedAreas: restrictedAreasFor({ allowed: true, reason: "inside" }),
    };
    expect(can(allowed, "finance.bank.manage")).toBe(true);
    expect(can(allowed, "accounting.journals.view")).toBe(true);
  });
});

describe("insideHours / localClock / describe", () => {
  it("reads the local clock and refuses an unknown timezone", () => {
    expect(localClock(new Date("2026-10-12T20:30:00Z"), "Asia/Dubai")).toEqual({
      day: 2,
      minute: 30,
    });
    expect(localClock(new Date(), "Mars/Base")).toBeNull();
  });

  it("wraps Sunday back to Monday's previous day", () => {
    expect(
      insideHours({ day: 1, minute: 60 }, { days: [7], start: "22:00", end: "02:00" }),
    ).toEqual({ inside: true });
  });

  it("describes the window in plain words", () => {
    expect(describeDays([1, 2, 3, 4, 5, 6])).toBe("Monday to Saturday");
    expect(describeDays([1, 3, 5])).toBe("Monday, Wednesday and Friday");
    expect(describeDays([2])).toBe("Tuesday");
    expect(describeDays([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(describeWindow(DEFAULT_FINANCE_ACCESS, "Asia/Dubai")).toBe(
      "Monday to Saturday, 07:00 to 21:00 (Asia/Dubai)",
    );
    expect(describeWindow({ ...DEFAULT_FINANCE_ACCESS, limit_hours: false }, "Asia/Dubai")).toBe(
      "any time",
    );
  });
});

describe("shared parity fixtures (same cases as app.finance_window_reason in tests/db)", () => {
  type Case = {
    name: string;
    cfg: unknown;
    now?: string;
    timezone?: string;
    permissions?: string[];
    expect: string;
  };
  const fx = fixtures as { roleId: string; cases: Case[] };

  it.each(fx.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const d = financeAccessDecision({
      now: new Date(c.now ?? "2026-10-12T08:00:00Z"),
      timezone: c.timezone ?? "Asia/Dubai",
      stored: readFinanceAccess(c.cfg === null ? {} : { finance_access: c.cfg }),
      ip: parseIp("203.0.113.7"),
      member: { roleId: fx.roleId, permissions: c.permissions ?? ["finance.view", "inbox.send"] },
    });
    expect(d.reason).toBe(c.expect);
  });
});

describe("switched-off and half-filled settings", () => {
  it("honours a plain enabled:false before full validation", () => {
    const stored = readFinanceAccess({ finance_access: { enabled: false, days: "x" } });
    expect(stored).toEqual({ ok: false, settings: null, disabled: true });
    expect(decide({ stored })).toEqual({ allowed: true, reason: "off" });
  });

  it("saves a switched-off window with 'only these roles' and no roles", () => {
    expect(
      financeAccessSchema.safeParse({ enabled: false, scope: "selected_roles", role_ids: [] })
        .success,
    ).toBe(true);
  });

  it("puts the reason class in the alert's dedupe key", () => {
    expect(denyReasonClass("outside_hours")).toBe("time");
    expect(denyReasonClass("day_not_allowed")).toBe("time");
    expect(denyReasonClass("ip_not_allowed")).toBe("network");
    expect(denyReasonClass("ip_unknown")).toBe("network");
    expect(denyReasonClass("invalid_settings")).toBe("settings");
  });
});

describe("isNamedTimeZone", () => {
  it("accepts IANA names and refuses offsets Postgres would read the other way round", () => {
    for (const tz of [
      "Asia/Dubai",
      "Europe/London",
      "UTC",
      "Etc/GMT-4",
      "America/Argentina/Buenos_Aires",
    ])
      expect(isNamedTimeZone(tz), tz).toBe(true);
    for (const tz of [
      "+04:00",
      "-03:00",
      "UTC+4",
      "GMT-3",
      "utc+04:00",
      "posix/Asia/Dubai",
      "right/UTC",
      "posixrules",
      "",
      "4",
    ])
      expect(isNamedTimeZone(tz), tz).toBe(false);
    expect(localClock(new Date("2026-10-12T08:00:00Z"), "+04:00")).toBeNull();
  });
});
