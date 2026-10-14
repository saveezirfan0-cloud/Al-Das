import {
  evaluateEnv,
  evaluateQueues,
  type Check,
  type CronStatus,
  type EnvLike,
} from "@/lib/cutover/preflight";
import { doneCount, nextStep, type ReadinessStep } from "@/lib/finance/readiness";
import type { IntegrationKind } from "@/lib/integrations/catalog";
import type { HealthState } from "@/lib/integrations/health";

/**
 * Go-live checklist (Settings, Go-live checklist). Pure: turns facts gathered by the page into rows. It reuses the
 * cut-over preflight evaluators (no Meta or other network call), the finance setup steps, the integration catalogue's
 * readiness problems and health, and the cron status from System health.
 *
 * Environment variables go in, but only yes/no comes out: no row's detail ever holds a value (key, DSN, URL, sender).
 */

export type RowGroup = "Required" | "Optional";
export type RowStatus = "ok" | "warn" | "missing" | "blocked";

export type ReadinessRow = {
  key: string;
  label: string;
  group: RowGroup;
  status: RowStatus;
  detail: string;
  /** Where it is fixed. Null = in the hosting environment (Vercel project settings), not in Pulse. */
  href: string | null;
  /** Permission needed to open `href`, so the page can avoid offering a link that would be refused. */
  perm?: string;
};

export type IntegrationFact = {
  kind: IntegrationKind;
  title: string;
  enabled: boolean;
  health: HealthState;
  /** readinessProblems() for an integration that is off; null when not checked (the viewer cannot manage integrations). */
  problems: string[] | null;
  /** Permission needed to open its settings page. */
  viewPermission: string;
};

export type GoLiveInput = {
  env: EnvLike;
  whatsapp: { channels: number; active: number; approvedTemplates: number };
  trainingMode: boolean;
  unite: { credentials: boolean; syncOn: boolean };
  /** Finance setup steps (lib/finance/readiness.ts); null when the viewer cannot read finance data. */
  finance: readonly ReadinessStep[] | null;
  integrations: readonly IntegrationFact[];
  cron: { available: boolean; jobs: readonly CronStatus[] };
  deadLetters: number;
  now?: number;
};

const ENV_HREF = null;
const has = (env: EnvLike, k: string) => !!env[k]?.trim();

/** Variables the app cannot start safely without (from the preflight's blocker checks). */
const SERVER_CHECKS = [
  "env:NEXT_PUBLIC_SUPABASE_URL",
  "env:NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "env:SUPABASE_SERVICE_ROLE_KEY",
  "env:ENCRYPTION_KEY",
  "env:ENCRYPTION_KEY:valid",
  "env:JOB_SECRET",
  "env:APP_URL",
  "env:graph-base",
] as const;

/** Friendly names for failed preflight checks; the preflight's own detail can hold a value (APP_URL), so it is never shown. */
const CHECK_LABEL: Record<string, string> = {
  "env:NEXT_PUBLIC_SUPABASE_URL": "Supabase URL",
  "env:NEXT_PUBLIC_SUPABASE_ANON_KEY": "Supabase anon key",
  "env:SUPABASE_SERVICE_ROLE_KEY": "Supabase service role key",
  "env:ENCRYPTION_KEY": "ENCRYPTION_KEY",
  "env:ENCRYPTION_KEY:valid": "ENCRYPTION_KEY is not 32 bytes (base64)",
  "env:JOB_SECRET": "JOB_SECRET (16+ characters)",
  "env:APP_URL": "APP_URL is not a public https address",
  "env:graph-base": "META_GRAPH_BASE_URL (load-test stub) must be removed",
  "env:META_APP_ID": "META_APP_ID",
  "env:META_APP_SECRET": "META_APP_SECRET",
  "env:META_WEBHOOK_VERIFY_TOKEN": "META_WEBHOOK_VERIFY_TOKEN",
  "env:workspace-creation": "ALLOW_WORKSPACE_CREATION is still on",
  "env:AIRTABLE_PAT:remove": "AIRTABLE_PAT is still set",
  "env:MAKE_API_TOKEN:remove": "MAKE_API_TOKEN is still set",
};

function failing(checks: readonly Check[], ids: readonly string[]): string[] {
  return ids
    .map((id) => checks.find((c) => c.id === id))
    .filter((c): c is Check => !!c && !c.ok)
    .map((c) => CHECK_LABEL[c.id] ?? c.id);
}

function minutesAgo(iso: string | null, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 120) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function envRows(env: EnvLike): ReadinessRow[] {
  const checks = evaluateEnv(env);
  const server = failing(checks, SERVER_CHECKS);
  const meta = failing(checks, [
    "env:META_APP_ID",
    "env:META_APP_SECRET",
    "env:META_WEBHOOK_VERIFY_TOKEN",
  ]);
  const leftovers = failing(checks, [
    "env:workspace-creation",
    "env:AIRTABLE_PAT:remove",
    "env:MAKE_API_TOKEN:remove",
  ]);

  const resendKey = has(env, "RESEND_API_KEY");
  const fromOk = checks.find((c) => c.id === "env:resend-from")?.ok === true;
  const sentryServer = has(env, "SENTRY_DSN") || has(env, "NEXT_PUBLIC_SENTRY_DSN");
  const sentryBrowser = has(env, "NEXT_PUBLIC_SENTRY_DSN");
  const vapid = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].filter((k) => has(env, k)).length;
  const fakeEmbeddings = env.EMBEDDINGS_PROVIDER?.trim() === "fake";

  return [
    {
      key: "server",
      label: "Server configuration",
      group: "Required",
      status: server.length ? "missing" : "ok",
      detail: server.length
        ? `Not ready: ${server.join("; ")}.`
        : "Database keys, encryption key, job secret and public address are set.",
      href: ENV_HREF,
    },
    {
      key: "meta-app",
      label: "Meta app for WhatsApp",
      group: "Required",
      status: meta.length ? "missing" : "ok",
      detail: meta.length
        ? `Not set: ${meta.join(", ")}. Without them Meta cannot deliver messages to Pulse.`
        : "App ID, app secret and webhook verify token are set.",
      href: ENV_HREF,
    },
    {
      key: "email",
      label: "E-mail (invites and alerts)",
      group: "Required",
      status: !resendKey ? "missing" : fromOk ? "ok" : "warn",
      detail: !resendKey
        ? "RESEND_API_KEY is not set: invitations and e-mail alerts cannot be sent."
        : fromOk
          ? "Resend key and sender address are set."
          : "RESEND_FROM still uses the example.com default: set a sender on your verified domain.",
      href: ENV_HREF,
    },
    {
      key: "leftovers",
      label: "Set-up-only settings removed",
      group: "Required",
      status: leftovers.length ? "warn" : "ok",
      detail: leftovers.length
        ? `Remove after the final import: ${leftovers.join("; ")}.`
        : "No migration tokens left, and new workspaces cannot be created.",
      href: ENV_HREF,
    },
    {
      key: "sentry",
      label: "Error reporting (Sentry)",
      group: "Optional",
      status:
        sentryServer && sentryBrowser ? "ok" : sentryServer || sentryBrowser ? "warn" : "missing",
      detail:
        sentryServer && sentryBrowser
          ? "Server and browser DSNs are set (presence only; send a test error to confirm)."
          : sentryServer
            ? "Server errors are reported; set NEXT_PUBLIC_SENTRY_DSN and rebuild for browser errors."
            : sentryBrowser
              ? "Browser errors are reported; set SENTRY_DSN for server errors."
              : "SENTRY_DSN is not set: errors are only in the hosting logs.",
      href: ENV_HREF,
    },
    {
      key: "push",
      label: "Phone and desktop push",
      group: "Optional",
      status: vapid === 2 ? "ok" : vapid === 1 ? "warn" : "missing",
      detail:
        vapid === 2
          ? "VAPID keys are set."
          : vapid === 1
            ? "Only one of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is set."
            : "Not set (pnpm push:keys): in-app and e-mail notifications still work.",
      href: ENV_HREF,
    },
    {
      key: "ai",
      label: "AI drafts and copilots",
      group: "Optional",
      status: has(env, "ANTHROPIC_API_KEY") ? "ok" : "missing",
      detail: has(env, "ANTHROPIC_API_KEY")
        ? "ANTHROPIC_API_KEY is set. Each feature still has its own switch."
        : "ANTHROPIC_API_KEY is not set: AI drafts and copilots stay off.",
      href: "/settings/ai-copilots",
      perm: "settings.manage",
    },
    {
      key: "embeddings",
      label: "Knowledge-base search",
      group: "Optional",
      status: fakeEmbeddings ? "warn" : has(env, "EMBEDDINGS_API_KEY") ? "ok" : "missing",
      detail: fakeEmbeddings
        ? "EMBEDDINGS_PROVIDER is set to the test-only fake provider."
        : has(env, "EMBEDDINGS_API_KEY")
          ? "EMBEDDINGS_API_KEY is set."
          : "EMBEDDINGS_API_KEY is not set: the knowledge base cannot be searched.",
      href: "/settings/knowledge-base",
      perm: "settings.manage",
    },
  ];
}

function cronRow(input: GoLiveInput, now: number): ReadinessRow[] {
  const base = {
    group: "Required" as const,
    href: "/settings/system-health",
    perm: "settings.manage",
  };
  const checks = evaluateQueues(
    [],
    input.deadLetters,
    0,
    input.cron.available ? [...input.cron.jobs] : null,
    now,
  );
  const dead = checks.find((c) => c.id === "jobs:dead-letters")!;
  const deadRow: ReadinessRow = {
    ...base,
    key: "dead-letters",
    label: "No failed jobs waiting",
    status: dead.ok ? "ok" : "warn",
    detail: dead.ok
      ? "No unresolved dead letters."
      : `${input.deadLetters} failed job(s): retry or discard them in System health.`,
  };
  if (!input.cron.available)
    return [
      {
        ...base,
        key: "cron",
        label: "Scheduled jobs (pg_cron)",
        status: "warn",
        detail: "pg_cron status cannot be read on this database (normal for local development).",
      },
      deadRow,
    ];

  const pulse = input.cron.jobs.filter((j) => j.jobname.startsWith("pulse:"));
  const last = pulse
    .map((j) => j.last_end)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  const bad = checks.filter((c) => c.id.startsWith("jobs:cron") && !c.ok);
  let status: RowStatus = "ok";
  let detail = `${pulse.length} jobs active; last run ${minutesAgo(last ?? null, now)}.`;
  if (pulse.length === 0) {
    status = "missing";
    detail = "No pulse:* cron jobs found: queues are never drained.";
  } else if (bad.length) {
    status = "warn";
    // Only job names leave this function (the checks' details are job names and statuses too).
    detail = `${bad.map((c) => c.detail).join("; ")}. Last run ${minutesAgo(last ?? null, now)}.`;
  }
  return [{ ...base, key: "cron", label: "Scheduled jobs (pg_cron)", status, detail }, deadRow];
}

function financeRow(steps: readonly ReadinessStep[] | null): ReadinessRow {
  const base = {
    key: "finance",
    label: "Finance and insurance",
    group: "Optional" as const,
    href: "/finance/health",
    perm: "finance.capture.manage",
  };
  if (!steps)
    return {
      ...base,
      status: "blocked",
      detail: "Needs a finance role to check (Settings, Finance data health).",
    };
  const done = doneCount(steps);
  const next = nextStep(steps);
  if (done === steps.length)
    return { ...base, status: "ok", detail: `All ${steps.length} set-up steps are done.` };
  return {
    ...base,
    status: done === 0 ? "missing" : "warn",
    detail: `${done} of ${steps.length} set-up steps done.${next ? ` Next: ${next.label}.` : ""}`,
    ...(next ? { href: next.href, perm: next.perm } : {}),
  };
}

function integrationRow(i: IntegrationFact): ReadinessRow {
  const base = {
    key: `integration:${i.kind}`,
    label: i.title,
    group: "Optional" as const,
    href: `/settings/integrations/${i.kind}`,
    perm: i.viewPermission,
  };
  if (i.enabled) {
    if (i.health === "down")
      return { ...base, status: "warn", detail: "On, but recent calls are failing." };
    if (i.health === "degraded")
      return { ...base, status: "warn", detail: "On, with some recent failures." };
    return {
      ...base,
      status: "ok",
      detail: i.health === "idle" ? "On; not used yet." : "On and healthy.",
    };
  }
  if (i.problems === null) return { ...base, status: "missing", detail: "Off." };
  if (i.problems.length === 0)
    return { ...base, status: "missing", detail: "Off. Everything it needs is filled in." };
  const more = i.problems.length > 1 ? ` (+${i.problems.length - 1} more)` : "";
  return { ...base, status: "missing", detail: `Off. ${i.problems[0]}${more}` };
}

export function goLiveRows(input: GoLiveInput): ReadinessRow[] {
  const now = input.now ?? Date.now();
  const wa = input.whatsapp;
  const env = envRows(input.env);
  const required = env.filter((r) => r.group === "Required");
  const optional = env.filter((r) => r.group === "Optional");

  return [
    ...required.slice(0, 2),
    {
      key: "whatsapp",
      label: "WhatsApp number connected",
      group: "Required",
      status: wa.active > 0 ? "ok" : wa.channels > 0 ? "warn" : "missing",
      detail:
        wa.active > 0
          ? `${wa.active} active number(s).`
          : wa.channels > 0
            ? `${wa.channels} number(s) added, none active.`
            : "No WhatsApp number has been added.",
      href: "/settings/channels",
      perm: "settings.manage",
    },
    {
      key: "templates",
      label: "Approved message templates",
      group: "Required",
      status: wa.approvedTemplates > 0 ? "ok" : wa.channels === 0 ? "blocked" : "missing",
      detail:
        wa.approvedTemplates > 0
          ? `${wa.approvedTemplates} approved by Meta (reminders and messages outside 24 hours need them).`
          : wa.channels === 0
            ? "Add a WhatsApp number first."
            : "No approved template yet: reminders and replies after 24 hours cannot be sent.",
      href: "/templates",
      perm: "templates.manage",
    },
    {
      key: "training",
      label: "Training mode is off",
      group: "Required",
      status: input.trainingMode ? "warn" : "ok",
      detail: input.trainingMode
        ? "Training mode is on: messages are shown on screen and never sent to Meta."
        : "Messages go to Meta.",
      href: "/settings/training",
      perm: "settings.manage",
    },
    {
      key: "unite",
      label: "Unite EMR (read-only)",
      group: "Required",
      status: !input.unite.credentials ? "missing" : input.unite.syncOn ? "ok" : "warn",
      detail: !input.unite.credentials
        ? "No Unite credentials stored."
        : input.unite.syncOn
          ? "Credentials stored and at least one sync is on."
          : "Credentials stored; every sync is still off.",
      href: "/settings/unite",
      perm: "settings.manage",
    },
    ...cronRow(input, now),
    ...required.slice(2),
    ...optional,
    financeRow(input.finance),
    ...input.integrations.map(integrationRow),
  ];
}

export function summariseRows(rows: readonly ReadinessRow[]) {
  const required = rows.filter((r) => r.group === "Required");
  return {
    requiredReady: required.filter((r) => r.status === "ok").length,
    requiredTotal: required.length,
    optionalReady: rows.filter((r) => r.group === "Optional" && r.status === "ok").length,
    optionalTotal: rows.filter((r) => r.group === "Optional").length,
    attention: rows.filter(
      (r) => r.status === "warn" || (r.group === "Required" && r.status === "missing"),
    ).length,
  };
}
