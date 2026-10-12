import { describe, expect, it } from "vitest";

import {
  bulkApiReadAlert,
  bulkExportAlert,
  failedLoginAlert,
  isOffHours,
  localDay,
  offHoursAlert,
  roleChangeAlert,
} from "@/lib/security/anomaly";
import { shouldLogAccess } from "@/lib/security/sampling";
import {
  DEFAULT_SECURITY_SETTINGS,
  readSecuritySettings,
  securitySettingsSchema,
  writeSecuritySettings,
} from "@/lib/security/settings";

const S = DEFAULT_SECURITY_SETTINGS;
const window = (start: string, end: string, enabled = true) => ({ enabled, start, end });

describe("isOffHours", () => {
  // 2026-10-12 05:30 UTC is 09:30 in Dubai (UTC+4)
  const nineThirtyDubai = new Date("2026-10-12T05:30:00Z");
  const elevenPmDubai = new Date("2026-10-12T19:00:00Z");
  const threeAmDubai = new Date("2026-10-11T23:00:00Z");

  it("uses the org timezone, not UTC", () => {
    expect(isOffHours(nineThirtyDubai, "Asia/Dubai", window("07:00", "21:00"))).toBe(false);
    expect(isOffHours(nineThirtyDubai, "UTC", window("07:00", "21:00"))).toBe(true); // 05:30 UTC
    expect(isOffHours(elevenPmDubai, "Asia/Dubai", window("07:00", "21:00"))).toBe(true);
    expect(isOffHours(threeAmDubai, "Asia/Dubai", window("07:00", "21:00"))).toBe(true);
  });
  it("is half-open: the start is inside, the end is outside", () => {
    expect(
      isOffHours(new Date("2026-10-12T03:00:00Z"), "Asia/Dubai", window("07:00", "21:00")),
    ).toBe(false); // 07:00
    expect(
      isOffHours(new Date("2026-10-12T17:00:00Z"), "Asia/Dubai", window("07:00", "21:00")),
    ).toBe(true); // 21:00
  });
  it("supports a window that wraps midnight (night shift)", () => {
    expect(
      isOffHours(new Date("2026-10-12T19:00:00Z"), "Asia/Dubai", window("20:00", "06:00")),
    ).toBe(false); // 23:00 is on shift
    expect(
      isOffHours(new Date("2026-10-12T22:00:00Z"), "Asia/Dubai", window("20:00", "06:00")),
    ).toBe(false); // 02:00 is on shift
    expect(
      isOffHours(new Date("2026-10-12T08:00:00Z"), "Asia/Dubai", window("20:00", "06:00")),
    ).toBe(true); // 12:00 is not
  });
  it("can be switched off, and an empty window means no restriction", () => {
    expect(isOffHours(elevenPmDubai, "Asia/Dubai", window("07:00", "21:00", false))).toBe(false);
    expect(isOffHours(elevenPmDubai, "Asia/Dubai", window("00:00", "00:00"))).toBe(false);
  });
  it("falls back to UTC for a bad timezone instead of throwing", () => {
    expect(() => isOffHours(nineThirtyDubai, "Not/AZone", window("07:00", "21:00"))).not.toThrow();
    expect(localDay(nineThirtyDubai, "Not/AZone")).toBe("2026-10-12");
  });
});

describe("alerts", () => {
  const now = new Date("2026-10-12T10:00:00Z");

  it("bulk export: one big download, or a burst of small ones, once", () => {
    expect(
      bulkExportAlert(
        { userId: "u", entity: "contacts", rows: 999, exportsLastHour: 1, now, exportId: "1" },
        S,
      ),
    ).toBeNull();
    const big = bulkExportAlert(
      { userId: "u", entity: "contacts", rows: 1000, exportsLastHour: 1, now, exportId: "42" },
      S,
    )!;
    expect(big).toMatchObject({ kind: "bulk_export", dedupeKey: "bulk_export:42", userId: "u" });
    expect(big.summary).toContain("1000");
    const burst1 = bulkExportAlert(
      { userId: "u", entity: "contacts", rows: 10, exportsLastHour: 5, now, exportId: "50" },
      S,
    )!;
    const burst2 = bulkExportAlert(
      { userId: "u", entity: "contacts", rows: 10, exportsLastHour: 6, now, exportId: "51" },
      S,
    )!;
    expect(burst1.dedupeKey).toBe(burst2.dedupeKey); // same person, same hour: one alert
  });

  it("off-hours access: once per person per local day, nothing in working hours", () => {
    const night = new Date("2026-10-12T19:00:00Z"); // 23:00 Dubai
    expect(
      offHoursAlert({ userId: "u", entity: "contact", now, timeZone: "Asia/Dubai" }, S),
    ).toBeNull();
    const a = offHoursAlert(
      { userId: "u", entity: "contact", now: night, timeZone: "Asia/Dubai" },
      S,
    )!;
    const b = offHoursAlert(
      {
        userId: "u",
        entity: "conversation",
        now: new Date("2026-10-12T19:30:00Z"),
        timeZone: "Asia/Dubai",
      },
      S,
    )!;
    expect(a.kind).toBe("off_hours_access");
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).toBe("off_hours:u:2026-10-12");
    expect(
      offHoursAlert({ userId: "v", entity: "contact", now: night, timeZone: "Asia/Dubai" }, S)!
        .dedupeKey,
    ).not.toBe(a.dedupeKey);
  });

  it("failed sign-ins: five by default, one alert per window", () => {
    expect(failedLoginAlert({ subjectKey: "h", userId: "u", failures: 4, now }, S)).toBeNull();
    const a = failedLoginAlert({ subjectKey: "h", userId: "u", failures: 5, now }, S)!;
    const later = failedLoginAlert(
      { subjectKey: "h", userId: "u", failures: 9, now: new Date(now.getTime() + 60_000) },
      S,
    )!;
    const nextWindow = failedLoginAlert(
      { subjectKey: "h", userId: "u", failures: 5, now: new Date(now.getTime() + 20 * 60_000) },
      S,
    )!;
    expect(a.kind).toBe("failed_logins");
    expect(a.dedupeKey).toBe(later.dedupeKey);
    expect(nextWindow.dedupeKey).not.toBe(a.dedupeKey);
    expect(
      failedLoginAlert(
        { subjectKey: "h", userId: "u", failures: 3, now },
        { ...S, failed_login_threshold: 3 },
      ),
    ).not.toBeNull();
  });

  it("role changes always alert, each event separately", () => {
    const a = roleChangeAlert({
      actorId: "admin",
      kind: "member_role_changed",
      targetId: "t",
      roleName: "Admin",
      grantsFullAccess: true,
      eventId: "e1",
    });
    const b = roleChangeAlert({
      actorId: "admin",
      kind: "member_role_changed",
      targetId: "t",
      roleName: "Admin",
      grantsFullAccess: true,
      eventId: "e2",
    });
    expect(a.kind).toBe("role_change");
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(a.summary).toContain("full access");
    expect(
      roleChangeAlert({ actorId: "a", kind: "role_deleted", targetId: "r", eventId: "e3" }).summary,
    ).toBe("A role was deleted");
  });

  it("bulk API reads: threshold per key per hour", () => {
    expect(bulkApiReadAlert({ apiKeyId: "k", rowsLastHour: 4999, now }, 5000)).toBeNull();
    const a = bulkApiReadAlert({ apiKeyId: "k", rowsLastHour: 5000, now }, 5000)!;
    expect(a).toMatchObject({ kind: "bulk_api_read", dedupeKey: "bulk_api_read:k:2026-10-12T10" });
  });
});

describe("shouldLogAccess", () => {
  it("always logs single-record opens, downloads and exports, whatever the sample rate", () => {
    for (const a of ["view", "download", "export"] as const) {
      expect(shouldLogAccess(a, 0, () => 0.99)).toBe(true);
    }
  });
  it("samples list and search views", () => {
    expect(shouldLogAccess("list", 0.1, () => 0.05)).toBe(true);
    expect(shouldLogAccess("list", 0.1, () => 0.5)).toBe(false);
    expect(shouldLogAccess("search", 0, () => 0)).toBe(false);
    expect(shouldLogAccess("search", 1, () => 0.999)).toBe(true);
  });
});

describe("security settings", () => {
  it("has the brief's defaults and survives junk", () => {
    expect(S.failed_login_threshold).toBe(5);
    expect(S.dormant_days).toBe(30);
    expect(S.access_log_retention_days).toBe(365);
    expect(readSecuritySettings(null)).toEqual(S);
    expect(readSecuritySettings({ security: { failed_login_threshold: "five" } })).toEqual(S);
    expect(readSecuritySettings({ security: { list_sample_rate: 0.5 } }).list_sample_rate).toBe(
      0.5,
    );
  });
  it("enforces bounds, notably a retention floor of 30 days", () => {
    expect(securitySettingsSchema.safeParse({ access_log_retention_days: 29 }).success).toBe(false);
    expect(securitySettingsSchema.safeParse({ list_sample_rate: 1.5 }).success).toBe(false);
    expect(
      securitySettingsSchema.safeParse({ off_hours: { enabled: true, start: "7am", end: "21:00" } })
        .success,
    ).toBe(false);
  });
  it("round-trips and keeps other org settings", () => {
    const written = writeSecuritySettings(
      { ai: { enabled: true } },
      { ...S, bulk_export_rows: 250 },
    );
    expect(written.ai).toEqual({ enabled: true });
    expect(readSecuritySettings(written).bulk_export_rows).toBe(250);
  });
});
