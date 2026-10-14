import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readinessSteps } from "@/lib/finance/readiness";
import {
  clinicSetupRows,
  goLiveRows,
  setupProgress,
  summariseRows,
  type ClinicFacts,
  type GoLiveInput,
} from "@/lib/golive/readiness";

const NOW = Date.parse("2026-10-14T10:00:00Z");

const goodEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "svc-secret-value",
  META_APP_ID: "123",
  META_APP_SECRET: "meta-secret-value",
  META_WEBHOOK_VERIFY_TOKEN: "verify",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  JOB_SECRET: "j".repeat(32),
  APP_URL: "https://pulse.aldas.example",
  RESEND_API_KEY: "re_resendkeyvalue",
  RESEND_FROM: "Pulse <no-reply@aldas.example.ae>",
  SENTRY_DSN: "https://dsnkey@o1.ingest.sentry.io/1",
  NEXT_PUBLIC_SENTRY_DSN: "https://dsnkey@o1.ingest.sentry.io/1",
  VAPID_PUBLIC_KEY: "vapidpub",
  VAPID_PRIVATE_KEY: "vapidpriv",
  ANTHROPIC_API_KEY: "sk-ant-anthropickey",
  EMBEDDINGS_API_KEY: "embkey",
};

const recent = new Date(NOW - 60_000).toISOString();
const cronJobs = ["meta_events", "outbound", "scheduler"].map((n) => ({
  jobname: `pulse:${n}`,
  active: true,
  last_status: "succeeded",
  last_end: recent,
}));

const doneFinance = readinessSteps({
  credentialsConfigured: true,
  captureEnabled: true,
  batchCount: 1,
  invoiceCount: 10,
  claimCount: 5,
  branchesMapped: 2,
  activeRules: 3,
  lastImportAt: recent,
});

const clinic: ClinicFacts = {
  locations: 2,
  locationsWithCode: 2,
  services: 5,
  doctors: 3,
  doctorsWithHours: 3,
  doctorsLinked: 2,
  members: 6,
  pendingInvites: 0,
  staff: 8,
};

const empty: ClinicFacts = {
  locations: 0,
  locationsWithCode: 0,
  services: 0,
  doctors: 0,
  doctorsWithHours: 0,
  doctorsLinked: 0,
  members: 1,
  pendingInvites: 0,
  staff: 0,
};

const good: GoLiveInput = {
  env: goodEnv,
  clinic,
  whatsapp: { channels: 1, active: 1, approvedTemplates: 4 },
  trainingMode: false,
  unite: { credentials: true, syncOn: true },
  finance: doneFinance,
  integrations: [
    {
      kind: "sms",
      title: "SMS fallback",
      enabled: true,
      health: "ok",
      problems: null,
      viewPermission: "integrations.manage",
    },
  ],
  cron: { available: true, jobs: cronJobs },
  deadLetters: 0,
  now: NOW,
};

const row = (input: GoLiveInput, key: string) => goLiveRows(input).find((r) => r.key === key)!;

describe("goLiveRows", () => {
  it("is all green for a ready workspace", () => {
    const rows = goLiveRows(good);
    expect(rows.filter((r) => r.status !== "ok").map((r) => r.key)).toEqual([]);
    const s = summariseRows(rows);
    expect(s.requiredReady).toBe(s.requiredTotal);
    expect(s.attention).toBe(0);
  });

  it("puts required rows first and every row has a group, status and detail", () => {
    const rows = goLiveRows(good);
    const firstOptional = rows.findIndex((r) => r.group === "Optional");
    expect(rows.slice(firstOptional).every((r) => r.group === "Optional")).toBe(true);
    for (const r of rows) {
      expect(["Required", "Optional"]).toContain(r.group);
      expect(["ok", "warn", "missing", "blocked"]).toContain(r.status);
      expect(r.detail.length).toBeGreaterThan(0);
    }
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("never puts an environment value in a row", () => {
    const text = JSON.stringify(goLiveRows(good));
    for (const v of [
      "svc-secret-value",
      "meta-secret-value",
      "re_resendkeyvalue",
      "dsnkey",
      "vapidpriv",
      "anthropickey",
      "embkey",
      "aldas.example",
      goodEnv.ENCRYPTION_KEY,
      goodEnv.JOB_SECRET,
    ])
      expect(text).not.toContain(v);
  });

  it("reports missing server settings and the Meta app as required and missing", () => {
    const input = {
      ...good,
      env: { ...goodEnv, APP_URL: "http://localhost:3000", META_APP_SECRET: "" },
    };
    expect(row(input, "server")).toMatchObject({ status: "missing", href: null });
    expect(row(input, "server").detail).toContain("APP_URL is not a public https address");
    expect(row(input, "server").detail).not.toContain("localhost");
    expect(row(input, "meta-app")).toMatchObject({ status: "missing", group: "Required" });
  });

  it("e-mail: missing without a key, warn on the example.com sender", () => {
    expect(row({ ...good, env: { ...goodEnv, RESEND_API_KEY: "" } }, "email").status).toBe(
      "missing",
    );
    expect(row({ ...good, env: { ...goodEnv, RESEND_FROM: "" } }, "email").status).toBe("warn");
  });

  it("Sentry, push, AI and embeddings are optional with partial states", () => {
    const env = {
      ...goodEnv,
      NEXT_PUBLIC_SENTRY_DSN: "",
      VAPID_PRIVATE_KEY: "",
      ANTHROPIC_API_KEY: "",
    };
    const input = { ...good, env };
    expect(row(input, "sentry")).toMatchObject({ status: "warn", group: "Optional" });
    expect(row(input, "push").status).toBe("warn");
    expect(row(input, "ai").status).toBe("missing");
    expect(
      row({ ...good, env: { ...goodEnv, SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "" } }, "sentry")
        .status,
    ).toBe("missing");
    expect(
      row({ ...good, env: { ...goodEnv, EMBEDDINGS_PROVIDER: "fake" } }, "embeddings").status,
    ).toBe("warn");
  });

  it("warns about migration leftovers", () => {
    const r = row({ ...good, env: { ...goodEnv, AIRTABLE_PAT: "pat-value" } }, "leftovers");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("AIRTABLE_PAT is still set");
    expect(r.detail).not.toContain("pat-value");
  });

  it("WhatsApp: no number blocks templates; an inactive number warns", () => {
    const none = { ...good, whatsapp: { channels: 0, active: 0, approvedTemplates: 0 } };
    expect(row(none, "whatsapp").status).toBe("missing");
    expect(row(none, "templates").status).toBe("blocked");
    const paused = { ...good, whatsapp: { channels: 1, active: 0, approvedTemplates: 0 } };
    expect(row(paused, "whatsapp").status).toBe("warn");
    expect(row(paused, "templates")).toMatchObject({ status: "missing", href: "/templates" });
  });

  it("training mode and Unite", () => {
    expect(row({ ...good, trainingMode: true }, "training").status).toBe("warn");
    expect(row({ ...good, unite: { credentials: false, syncOn: false } }, "unite").status).toBe(
      "missing",
    );
    expect(row({ ...good, unite: { credentials: true, syncOn: false } }, "unite").status).toBe(
      "warn",
    );
  });

  it("cron: unavailable, none, failing or stale; dead letters warn", () => {
    expect(row({ ...good, cron: { available: false, jobs: [] } }, "cron").status).toBe("warn");
    expect(row({ ...good, cron: { available: true, jobs: [] } }, "cron").status).toBe("missing");
    const failing = cronJobs.map((j, i) => (i === 0 ? { ...j, last_status: "failed" } : j));
    expect(row({ ...good, cron: { available: true, jobs: failing } }, "cron")).toMatchObject({
      status: "warn",
      href: "/settings/system-health",
    });
    const stale = cronJobs.map((j) => ({
      ...j,
      last_end: new Date(NOW - 3_600_000).toISOString(),
    }));
    const r = row({ ...good, cron: { available: true, jobs: stale } }, "cron");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("60 min ago");
    expect(row(good, "cron").detail).toContain("3 jobs active; last run 1 min ago");
    expect(row({ ...good, deadLetters: 2 }, "dead-letters").status).toBe("warn");
  });

  it("finance: hidden data is blocked, partial points at the next step", () => {
    expect(row({ ...good, finance: null }, "finance").status).toBe("blocked");
    const partial = readinessSteps({
      credentialsConfigured: true,
      captureEnabled: false,
      batchCount: 0,
      invoiceCount: 0,
      claimCount: 0,
      branchesMapped: 0,
      activeRules: 0,
      lastImportAt: null,
    });
    const r = row({ ...good, finance: partial }, "finance");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("1 of 6");
    expect(r.href).toBe("/finance/reference");
  });

  it("integrations: health when on, readiness problems when off", () => {
    const base = {
      kind: "payments" as const,
      title: "Payment links",
      viewPermission: "integrations.manage",
    };
    const mk = (over: Partial<GoLiveInput["integrations"][number]>) =>
      row(
        {
          ...good,
          integrations: [{ ...base, enabled: false, health: "off", problems: null, ...over }],
        },
        "integration:payments",
      );
    expect(mk({ enabled: true, health: "down" }).status).toBe("warn");
    expect(mk({ enabled: true, health: "degraded" }).status).toBe("warn");
    expect(mk({ enabled: true, health: "idle" })).toMatchObject({
      status: "ok",
      detail: "On; not used yet.",
    });
    expect(mk({ problems: ["Choose a provider.", "Secret key is missing."] })).toMatchObject({
      status: "missing",
      group: "Optional",
      detail: "Off. Choose a provider. (+1 more)",
      href: "/settings/integrations/payments",
    });
    expect(mk({ problems: [] }).detail).toContain("Everything it needs");
    expect(mk({ problems: null }).detail).toBe("Off.");
  });

  it("clinic set-up rows come right after the server rows, in set-up order, ending with WhatsApp", () => {
    const keys = goLiveRows(good).map((r) => r.key);
    expect(keys.slice(0, 10)).toEqual([
      "server",
      "meta-app",
      "branch",
      "services",
      "doctors",
      "users",
      "doctor-users",
      "staff",
      "whatsapp",
      "templates",
    ]);
    for (const r of clinicSetupRows(clinic, good.whatsapp)) {
      expect(r.group).toBe("Required");
      expect(r.href).toBeTruthy();
      expect(r.perm).toBeTruthy();
    }
  });

  it("clinic set-up: an empty workspace points at the first branch and waits on it", () => {
    const rows = clinicSetupRows(empty, { channels: 0, active: 0 });
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("branch")).toMatchObject({
      status: "missing",
      href: "/settings/appointments?tab=locations",
      perm: "settings.manage",
    });
    expect(by("services")).toMatchObject({
      status: "missing",
      href: "/settings/appointments?tab=services",
    });
    expect(by("doctors")).toMatchObject({
      status: "blocked",
      href: "/settings/appointments?tab=doctors",
    });
    expect(by("users")).toMatchObject({ status: "missing", href: "/settings/users" });
    expect(by("doctor-users").status).toBe("blocked");
    expect(by("staff")).toMatchObject({ status: "missing", href: "/staff", perm: "hr.view" });
    expect(by("whatsapp").status).toBe("missing");
  });

  it("clinic set-up: partial states warn", () => {
    const rows = clinicSetupRows(
      {
        ...clinic,
        locationsWithCode: 0,
        doctorsWithHours: 0,
        members: 1,
        pendingInvites: 2,
        doctorsLinked: 0,
      },
      { channels: 1, active: 1 },
    );
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("branch").status).toBe("warn");
    expect(by("branch").detail).toContain("finance branch code");
    expect(by("doctors").status).toBe("warn");
    expect(by("users")).toMatchObject({ status: "warn" });
    expect(by("users").detail).toContain("2 invitations");
    expect(by("doctor-users").status).toBe("missing");
    // A doctor exists but there is no branch yet: the doctor row asks for one rather than waiting.
    expect(
      clinicSetupRows({ ...empty, doctors: 1 }, { channels: 0, active: 0 }).find(
        (r) => r.key === "doctors",
      )!.status,
    ).toBe("warn");
  });

  it("clinic set-up: the staff row is left out without hr.view", () => {
    const rows = clinicSetupRows({ ...clinic, staff: null }, good.whatsapp);
    expect(rows.map((r) => r.key)).not.toContain("staff");
    expect(rows.every((r) => r.status === "ok")).toBe(true);
  });

  it("clinic set-up rows carry counts only", () => {
    const text = JSON.stringify(clinicSetupRows(clinic, good.whatsapp));
    expect(text).toContain("2 branches, 2 with a finance branch code");
    expect(text).toContain("3 of 3 doctors have working hours");
    expect(text).toContain("2 of 3 doctors linked");
    expect(text).toContain("8 staff members");
  });
});

describe("setupProgress", () => {
  it("lists the next three open steps, anything waiting on another last", () => {
    const p = setupProgress(clinicSetupRows(empty, { channels: 0, active: 0 }));
    expect(p).toMatchObject({ done: 0, total: 7, complete: false });
    expect(p.next.map((r) => r.key)).toEqual(["branch", "services", "users"]);
    const late = setupProgress(
      clinicSetupRows({ ...clinic, doctorsLinked: 0 }, { channels: 0, active: 0 }),
    );
    expect(late.next.map((r) => r.key)).toEqual(["doctor-users", "whatsapp"]);
    expect(late.done).toBe(late.total - 2);
  });

  it("is complete when every row is ready", () => {
    const p = setupProgress(clinicSetupRows(clinic, { channels: 1, active: 1 }));
    expect(p).toMatchObject({ complete: true, next: [] });
    expect(p.done).toBe(p.total);
  });
});
