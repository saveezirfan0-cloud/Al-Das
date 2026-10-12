import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordAccess, recordExport } from "@/lib/security/access-log";
import { raiseAlert } from "@/lib/security/alerts";
import { recordAuthEvent, recordFailedSignIn, trackSession } from "@/lib/security/auth-events";
import { DEFAULT_SECURITY_SETTINGS } from "@/lib/security/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

process.env.JOB_SECRET = "test-job-secret-test-job-secret";
process.env.ENCRYPTION_KEY = "test-encryption-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";

const ORG = "org-1";
const USER = "user-1";
const asAdmin = (a: FakeAdmin) => a as unknown as AdminClient;
const dubai = { orgId: ORG, userId: USER, org: { timezone: "Asia/Dubai", settings: {} } };

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createFakeAdmin(
    {
      memberships: [
        {
          id: "m1",
          org_id: ORG,
          user_id: USER,
          status: "active",
          created_at: "2026-01-01",
          roles: { permissions: ["*"] },
        },
        {
          id: "m2",
          org_id: ORG,
          user_id: "admin-2",
          status: "active",
          created_at: "2026-01-02",
          roles: { permissions: ["settings.manage"] },
        },
        {
          id: "m3",
          org_id: ORG,
          user_id: "agent-3",
          status: "active",
          created_at: "2026-01-03",
          roles: { permissions: ["inbox.send"] },
        },
      ],
      profiles: [{ id: USER, email: "pat@example.test" }],
      orgs: [{ id: ORG, settings: {} }],
      record_access_log: [],
      security_alerts: [],
      notifications: [],
      auth_events: [],
      user_sessions: [],
      ...extra,
    },
    {
      unique: {
        security_alerts: [["org_id", "dedupe_key"]],
        user_sessions: [["user_id", "session_id"]],
      },
      defaults: {
        record_access_log: () => ({ at: new Date().toISOString() }),
        auth_events: () => ({ at: new Date().toISOString() }),
      },
    },
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("raiseAlert", () => {
  const draft = {
    kind: "bulk_export" as const,
    userId: USER,
    dedupeKey: "k1",
    summary: "Large export",
    detail: { rows: 5000 },
  };

  it("stores the alert and notifies everyone with settings access, but not other staff", async () => {
    const admin = seed();
    expect(await raiseAlert(asAdmin(admin), ORG, draft)).toBe(true);
    expect(admin._rows("security_alerts")).toHaveLength(1);
    const notified = admin
      ._rows("notifications")
      .map((n) => n.user_id)
      .sort();
    expect(notified).toEqual(["admin-2", USER]);
    expect(admin._rows("notifications")[0]).toMatchObject({
      type: "security.alert",
      org_id: ORG,
      body: "Large export",
    });
  });

  it("raises the same event only once", async () => {
    const admin = seed();
    expect(await raiseAlert(asAdmin(admin), ORG, draft)).toBe(true);
    expect(await raiseAlert(asAdmin(admin), ORG, draft)).toBe(false);
    expect(admin._rows("security_alerts")).toHaveLength(1);
    expect(admin._rows("notifications")).toHaveLength(2);
  });
});

describe("recordAccess", () => {
  it("always logs a single-record open, with ids only", async () => {
    const admin = seed();
    await recordAccess(
      asAdmin(admin),
      dubai,
      { entity: "contact", entityId: "c1", action: "view" },
      () => 0.99,
    );
    expect(admin._rows("record_access_log")).toEqual([
      expect.objectContaining({
        org_id: ORG,
        user_id: USER,
        entity: "contact",
        entity_id: "c1",
        action: "view",
        sampled: false,
      }),
    ]);
  });

  it("counts the same person re-opening the same record within five minutes as one open", async () => {
    const admin = seed();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T07:00:00Z"));
    const open = (id: string, who = dubai) =>
      recordAccess(asAdmin(admin), who, { entity: "conversation", entityId: id, action: "view" });
    await open("c1");
    await open("c1"); // a realtime refresh
    await open("c2"); // a different record
    await open("c1", { ...dubai, userId: "admin-2" }); // a different person
    expect(admin._rows("record_access_log")).toHaveLength(3);
    vi.setSystemTime(new Date("2026-10-12T07:06:00Z"));
    await open("c1"); // opened again later
    expect(admin._rows("record_access_log")).toHaveLength(4);
    // downloads are never merged
    await recordAccess(asAdmin(admin), dubai, {
      entity: "document",
      entityId: "d1",
      action: "download",
    });
    await recordAccess(asAdmin(admin), dubai, {
      entity: "document",
      entityId: "d1",
      action: "download",
    });
    expect(admin._rows("record_access_log").filter((r) => r.action === "download")).toHaveLength(2);
  });

  it("samples list views at the configured rate", async () => {
    const admin = seed();
    await recordAccess(asAdmin(admin), dubai, { entity: "contact", action: "list" }, () => 0.5); // default rate 0.1
    expect(admin._rows("record_access_log")).toHaveLength(0);
    await recordAccess(
      asAdmin(admin),
      dubai,
      { entity: "contact", action: "list", detail: { rows: 50 } },
      () => 0.01,
    );
    expect(admin._rows("record_access_log")).toEqual([
      expect.objectContaining({ action: "list", sampled: true, detail: { rows: 50 } }),
    ]);
  });

  it("raises one off-hours alert per day for a single-record open at night, none for a list or by day", async () => {
    const admin = seed();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T19:00:00Z")); // 23:00 in Dubai
    await recordAccess(asAdmin(admin), dubai, {
      entity: "contact",
      entityId: "c1",
      action: "view",
    });
    await recordAccess(asAdmin(admin), dubai, {
      entity: "contact",
      entityId: "c2",
      action: "view",
    });
    expect(admin._rows("record_access_log")).toHaveLength(2);
    expect(admin._rows("security_alerts")).toEqual([
      expect.objectContaining({
        kind: "off_hours_access",
        dedupe_key: `off_hours:${USER}:2026-10-12`,
      }),
    ]);

    const day = seed();
    vi.setSystemTime(new Date("2026-10-12T07:00:00Z")); // 11:00 in Dubai
    await recordAccess(asAdmin(day), dubai, { entity: "contact", entityId: "c1", action: "view" });
    expect(day._rows("security_alerts")).toHaveLength(0);
  });

  it("never throws when the database fails", async () => {
    const admin = seed();
    admin.from = (() => {
      throw new Error("db down");
    }) as never;
    await expect(
      recordAccess(asAdmin(admin), dubai, { entity: "contact", entityId: "c1", action: "view" }),
    ).resolves.toBeUndefined();
  });
});

describe("recordExport", () => {
  it("logs every export and alerts on a large one", async () => {
    const admin = seed();
    await recordExport(asAdmin(admin), dubai, { dataset: "contacts", rows: 40 });
    expect(admin._rows("security_alerts")).toHaveLength(0);
    await recordExport(asAdmin(admin), dubai, {
      dataset: "contacts",
      rows: DEFAULT_SECURITY_SETTINGS.bulk_export_rows,
    });
    expect(admin._rows("record_access_log")).toHaveLength(2);
    expect(admin._rows("record_access_log")[0]).toMatchObject({
      entity: "export",
      entity_id: "contacts",
      action: "export",
      detail: { rows: 40, format: "csv" },
    });
    expect(admin._rows("security_alerts")).toEqual([
      expect.objectContaining({ kind: "bulk_export" }),
    ]);
  });

  it("alerts on a burst of small exports within the hour", async () => {
    const admin = seed();
    for (let i = 0; i < 5; i++)
      await recordExport(asAdmin(admin), dubai, { dataset: "enquiries", rows: 10 });
    const alerts = admin._rows("security_alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toContain("5 exports");
  });
});

describe("auth events", () => {
  const headers = new Headers({
    "x-real-ip": "203.0.113.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36",
  });

  it("stores a hashed IP, the raw IP for now, and a coarse device family", async () => {
    const admin = seed();
    const { orgId } = await recordAuthEvent(asAdmin(admin), {
      type: "sign_in",
      userId: USER,
      method: "password",
      headers,
    });
    expect(orgId).toBe(ORG);
    const row = admin._rows("auth_events")[0];
    expect(row).toMatchObject({
      org_id: ORG,
      user_id: USER,
      event_type: "sign_in",
      method: "password",
      ua_family: "Chrome on Windows",
      ip_address: "203.0.113.9",
    });
    expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain("Mozilla");
  });

  it("stores no address when none is known", async () => {
    const admin = seed();
    await recordAuthEvent(asAdmin(admin), {
      type: "sign_out",
      userId: USER,
      orgId: ORG,
      headers: new Headers(),
    });
    expect(admin._rows("auth_events")[0]).toMatchObject({
      ip_hash: null,
      ip_address: null,
      ua_family: "Unknown device",
    });
  });

  it("raises one alert when failures reach five, and keeps the e-mail only as a hash", async () => {
    const admin = seed();
    for (let i = 0; i < 4; i++)
      await recordFailedSignIn(asAdmin(admin), { email: "Pat@Example.test", headers });
    expect(admin._rows("security_alerts")).toHaveLength(0);
    await recordFailedSignIn(asAdmin(admin), { email: "pat@example.test", headers });
    await recordFailedSignIn(asAdmin(admin), { email: "pat@example.test", headers });
    expect(admin._rows("auth_events")).toHaveLength(6);
    expect(admin._rows("security_alerts")).toEqual([
      expect.objectContaining({ kind: "failed_logins", user_id: USER }),
    ]);
    expect(JSON.stringify(admin._rows("auth_events"))).not.toContain("pat@example.test");
    expect(admin._rows("auth_events")[0]).toMatchObject({
      user_id: USER,
      org_id: ORG,
      event_type: "sign_in_failed",
    });
  });

  it("records failures for an unknown e-mail without an org and without alerting", async () => {
    const admin = seed();
    for (let i = 0; i < 6; i++)
      await recordFailedSignIn(asAdmin(admin), { email: "nobody@example.test", headers });
    expect(admin._rows("auth_events")).toHaveLength(6);
    expect(admin._rows("auth_events")[0]).toMatchObject({ user_id: null, org_id: null });
    expect(admin._rows("security_alerts")).toHaveLength(0);
  });

  it("tracks a session once per device id and never revives a revoked one", async () => {
    const admin = seed();
    const token = `h.${Buffer.from(JSON.stringify({ session_id: "sess-1", aal: "aal1" })).toString("base64url")}.s`;
    await trackSession(asAdmin(admin), { orgId: ORG, userId: USER, accessToken: token, headers });
    await trackSession(asAdmin(admin), { orgId: ORG, userId: USER, accessToken: token, headers });
    expect(admin._rows("user_sessions")).toHaveLength(1);
    admin._rows("user_sessions")[0].revoked_at = "2026-10-12T00:00:00Z";
    await trackSession(asAdmin(admin), { orgId: ORG, userId: USER, accessToken: token, headers });
    expect(admin._rows("user_sessions")[0].revoked_at).toBe("2026-10-12T00:00:00Z");
    await trackSession(asAdmin(admin), {
      orgId: ORG,
      userId: USER,
      accessToken: "garbage",
      headers,
    });
    expect(admin._rows("user_sessions")).toHaveLength(1);
  });
});
