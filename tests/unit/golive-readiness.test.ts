import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readinessSteps } from "@/lib/finance/readiness";
import { goLiveRows, summariseRows, type GoLiveInput } from "@/lib/golive/readiness";

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

const good: GoLiveInput = {
  env: goodEnv,
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
});
