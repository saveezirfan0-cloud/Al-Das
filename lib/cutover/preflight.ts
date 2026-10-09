/**
 * Cut-over preflight (Phase 11). Pure evaluators over facts collected read-only by
 * scripts/cutover-preflight.ts. Nothing in here, or in the script, writes to Pulse, Meta,
 * Unite, Airtable, Make or Sanoflow.
 *
 * Stages
 *   pre-cutover   a number is still on Sanoflow; we check that Pulse is ready to take it over
 *   post-cutover  the webhook has been moved; we check that traffic really flows through Pulse
 */

export type Stage = "pre-cutover" | "post-cutover";
export type Severity = "blocker" | "warning" | "info";
export type Check = {
  id: string;
  group: string;
  name: string;
  ok: boolean;
  severity: Severity;
  detail: string;
};

export type EnvLike = Record<string, string | undefined>;

const mk =
  (group: string) =>
  (id: string, name: string, ok: boolean, severity: Severity, detail: string): Check => ({
    id,
    group,
    name,
    ok,
    severity,
    detail,
  });

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function evaluateEnv(env: EnvLike): Check[] {
  const c = mk("Environment");
  const out: Check[] = [];
  const has = (k: string) => !!env[k]?.trim();

  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "META_APP_ID",
    "META_APP_SECRET",
    "META_WEBHOOK_VERIFY_TOKEN",
    "ENCRYPTION_KEY",
  ])
    out.push(c(`env:${k}`, `${k} is set`, has(k), "blocker", has(k) ? "set" : "missing"));

  const job = env.JOB_SECRET ?? "";
  out.push(
    c(
      "env:JOB_SECRET",
      "JOB_SECRET is at least 16 characters",
      job.length >= 16,
      "blocker",
      `${job.length} characters`,
    ),
  );

  let keyOk = false;
  let keyDetail = "missing";
  if (env.ENCRYPTION_KEY) {
    try {
      keyOk = Buffer.from(env.ENCRYPTION_KEY, "base64").length === 32;
      keyDetail = keyOk ? "32 bytes" : "does not decode to 32 bytes";
    } catch {
      keyDetail = "not base64";
    }
  }
  out.push(
    c(
      "env:ENCRYPTION_KEY:valid",
      "ENCRYPTION_KEY decodes to 32 bytes (AES-256-GCM)",
      keyOk,
      "blocker",
      keyDetail,
    ),
  );

  const url = env.APP_URL ?? "";
  const prodUrl = /^https:\/\//.test(url) && !/localhost|127\.0\.0\.1/.test(url);
  out.push(
    c(
      "env:APP_URL",
      "APP_URL is the public https address (the webhook and pg_cron call it)",
      prodUrl,
      "blocker",
      url || "missing",
    ),
  );

  const loopback = env.META_GRAPH_BASE_URL;
  out.push(
    c(
      "env:graph-base",
      "META_GRAPH_BASE_URL (load-test stub) is not set",
      !loopback,
      "blocker",
      loopback ? "set: sends would go to a stub" : "unset",
    ),
  );

  out.push(
    c(
      "env:workspace-creation",
      "ALLOW_WORKSPACE_CREATION is off",
      !["true", "1"].includes(env.ALLOW_WORKSPACE_CREATION ?? ""),
      "warning",
      env.ALLOW_WORKSPACE_CREATION ?? "unset",
    ),
  );
  out.push(
    c(
      "env:resend",
      "RESEND_API_KEY is set (invites, unread alerts)",
      has("RESEND_API_KEY"),
      "warning",
      has("RESEND_API_KEY") ? "set" : "missing",
    ),
  );
  out.push(
    c(
      "env:sentry",
      "SENTRY_DSN is set (error reporting)",
      has("SENTRY_DSN"),
      "warning",
      has("SENTRY_DSN") ? "set" : "missing",
    ),
  );
  out.push(
    c(
      "env:graph-version",
      "META_GRAPH_VERSION is pinned",
      has("META_GRAPH_VERSION"),
      "info",
      env.META_GRAPH_VERSION ?? "default",
    ),
  );

  // Later-phase integrations: informational until those phases ship.
  for (const k of [
    "UNITE_BASE_URL",
    "UNITE_APP_ID",
    "UNITE_APP_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
  ])
    out.push(
      c(
        `env:${k}`,
        `${k} (needed once its phase is live)`,
        has(k),
        "info",
        has(k) ? "set" : "not set",
      ),
    );

  // Migration-only secrets must not outlive the migration.
  for (const k of ["AIRTABLE_PAT", "MAKE_API_TOKEN"])
    out.push(
      c(
        `env:${k}:remove`,
        `${k} is removed from the production environment after the final import`,
        !has(k),
        "warning",
        has(k) ? "still set: remove after cut-over" : "not set",
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// Queues, cron, dead letters
// ---------------------------------------------------------------------------

export type QueueMetric = {
  queue_name: string;
  queue_length: number;
  oldest_msg_age_sec: number | null;
};
export type CronStatus = {
  jobname: string;
  active: boolean;
  last_status: string | null;
  last_end: string | null;
};

const HOT_QUEUES = ["meta_events", "outbound", "outbound_priority", "notifications", "media_fetch"];

export function evaluateQueues(
  metrics: QueueMetric[],
  deadLettersOpen: number,
  staleWebhookRows: number,
  cron: CronStatus[] | null,
  now: number = Date.now(),
): Check[] {
  const c = mk("Jobs");
  const out: Check[] = [];
  const stuck = metrics.filter(
    (m) =>
      HOT_QUEUES.includes(m.queue_name) && (m.oldest_msg_age_sec ?? 0) > 300 && m.queue_length > 0,
  );
  out.push(
    c(
      "jobs:backlog",
      "no message in a hot queue is older than 5 minutes",
      stuck.length === 0,
      "blocker",
      stuck.length
        ? stuck
            .map(
              (m) => `${m.queue_name}: ${m.queue_length} waiting, oldest ${m.oldest_msg_age_sec}s`,
            )
            .join("; ")
        : `${metrics.length} queues checked`,
    ),
  );
  out.push(
    c(
      "jobs:dead-letters",
      "no unresolved dead letters",
      deadLettersOpen === 0,
      "blocker",
      `${deadLettersOpen} open`,
    ),
  );
  out.push(
    c(
      "jobs:stale-webhooks",
      "no webhook payload unprocessed for more than 5 minutes",
      staleWebhookRows === 0,
      "blocker",
      `${staleWebhookRows} stale`,
    ),
  );

  if (cron === null) {
    out.push(
      c(
        "jobs:cron",
        "pg_cron jobs are active and succeeding",
        false,
        "warning",
        "cron status unavailable",
      ),
    );
  } else {
    const pulse = cron.filter((j) => j.jobname.startsWith("pulse:"));
    const inactive = pulse.filter((j) => !j.active);
    const failing = pulse.filter((j) => j.active && j.last_status && j.last_status !== "succeeded");
    const silent = pulse.filter(
      (j) =>
        j.active &&
        ["meta_events", "outbound", "scheduler"].some((n) => j.jobname === `pulse:${n}`) &&
        (!j.last_end || now - Date.parse(j.last_end) > 120_000),
    );
    out.push(
      c(
        "jobs:cron:active",
        "every pulse:* cron job is active",
        pulse.length > 0 && inactive.length === 0,
        "blocker",
        pulse.length === 0
          ? "no pulse:* jobs found"
          : inactive.map((j) => j.jobname).join(", ") || `${pulse.length} active`,
      ),
    );
    out.push(
      c(
        "jobs:cron:status",
        "the last run of every cron job succeeded",
        failing.length === 0,
        "blocker",
        failing.map((j) => `${j.jobname}: ${j.last_status}`).join("; ") || "all succeeded",
      ),
    );
    out.push(
      c(
        "jobs:cron:fresh",
        "the hot cron jobs ran in the last 2 minutes (vault secrets app_url/job_secret are set)",
        silent.length === 0,
        "blocker",
        silent.map((j) => j.jobname).join(", ") || "recent",
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Channels / Meta
// ---------------------------------------------------------------------------

export type ChannelFacts = {
  phoneNumberId: string;
  name: string;
  status: string;
  qualityRating: string | null;
  lastSyncedAt: string | null;
  hasOwnToken: boolean;
  templateCount: number;
  approvedTemplateCount: number;
  sendRatePerSec: number;
  /** From Meta (null when --skip-graph or the call failed). */
  meta: null | {
    reachable: boolean;
    error?: string;
    subscribedAppIds: string[];
    subscribedAppNames: string[];
    phoneStatus?: string;
  };
};

export function evaluateChannels(
  channels: ChannelFacts[],
  stage: Stage,
  opts: { metaAppId?: string; envTokenSet: boolean; now?: number },
): Check[] {
  const c = mk("WhatsApp");
  const now = opts.now ?? Date.now();
  const out: Check[] = [];
  out.push(
    c(
      "wa:channels",
      "at least one WhatsApp number is configured",
      channels.length > 0,
      "blocker",
      `${channels.length} number(s)`,
    ),
  );
  for (const ch of channels) {
    const id = ch.phoneNumberId;
    const label = `${ch.name} (${id})`;
    out.push(
      c(
        `wa:${id}:active`,
        `${label}: channel is active`,
        ch.status === "active",
        "blocker",
        ch.status,
      ),
    );
    out.push(
      c(
        `wa:${id}:token`,
        `${label}: has an access token`,
        ch.hasOwnToken || opts.envTokenSet,
        "blocker",
        ch.hasOwnToken
          ? "stored on the channel (encrypted)"
          : opts.envTokenSet
            ? "from META_SYSTEM_USER_TOKEN"
            : "none",
      ),
    );
    out.push(
      c(
        `wa:${id}:quality`,
        `${label}: quality rating is not RED`,
        ch.qualityRating !== "RED",
        "blocker",
        ch.qualityRating ?? "unknown",
      ),
    );
    out.push(
      c(
        `wa:${id}:templates`,
        `${label}: approved templates are mirrored`,
        ch.approvedTemplateCount > 0,
        stage === "pre-cutover" ? "blocker" : "warning",
        `${ch.approvedTemplateCount} approved of ${ch.templateCount}`,
      ),
    );
    const synced = ch.lastSyncedAt ? now - Date.parse(ch.lastSyncedAt) < 24 * 3600_000 : false;
    out.push(
      c(
        `wa:${id}:synced`,
        `${label}: phone fields synced from Meta in the last 24 h`,
        synced,
        "warning",
        ch.lastSyncedAt ?? "never",
      ),
    );
    out.push(
      c(
        `wa:${id}:rate`,
        `${label}: 2 x send_rate_per_sec stays within Meta throughput (80 msg/s default)`,
        ch.sendRatePerSec * 2 <= 80,
        "warning",
        `${ch.sendRatePerSec}/s configured`,
      ),
    );

    if (!ch.meta) {
      out.push(
        c(
          `wa:${id}:meta`,
          `${label}: Meta reachable with this token`,
          false,
          "warning",
          "not checked (--skip-graph)",
        ),
      );
      continue;
    }
    out.push(
      c(
        `wa:${id}:meta`,
        `${label}: Meta reachable with this token`,
        ch.meta.reachable,
        "blocker",
        ch.meta.reachable ? "ok" : (ch.meta.error ?? "failed"),
      ),
    );
    if (!ch.meta.reachable) continue;
    const ours = !!opts.metaAppId && ch.meta.subscribedAppIds.includes(opts.metaAppId);
    const others = ch.meta.subscribedAppNames.length - (ours ? 1 : 0);
    if (stage === "pre-cutover") {
      out.push(
        c(
          `wa:${id}:others`,
          `${label}: other apps still subscribed to the WABA (Sanoflow) — remove before moving the webhook`,
          true,
          "info",
          ch.meta.subscribedAppNames.join(", ") || "none",
        ),
      );
      out.push(
        c(
          `wa:${id}:ours-pre`,
          `${label}: Pulse app already subscribed`,
          true,
          "info",
          ours ? "yes" : "not yet (subscribe at cut-over)",
        ),
      );
    } else {
      out.push(
        c(
          `wa:${id}:ours`,
          `${label}: Pulse app is subscribed to the WABA`,
          ours,
          "blocker",
          ours ? "subscribed" : "NOT subscribed: inbound messages will not arrive",
        ),
      );
      out.push(
        c(
          `wa:${id}:legacy`,
          `${label}: no other (Sanoflow) app is still subscribed`,
          others === 0,
          "blocker",
          others === 0 ? "none" : ch.meta.subscribedAppNames.join(", "),
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data and sign-off
// ---------------------------------------------------------------------------

export type DataFacts = {
  openReviews: number;
  contactsLive: number;
  loadTestContacts: number;
  adminMembers: number;
  outboundFailed24h: number;
};

export function evaluateData(d: DataFacts): Check[] {
  const c = mk("Data");
  return [
    c(
      "data:contacts",
      "contacts have been imported",
      d.contactsLive > 0,
      "blocker",
      `${d.contactsLive} live contacts`,
    ),
    c(
      "data:reviews",
      "no unresolved import matches (sync_reviews)",
      d.openReviews === 0,
      "blocker",
      `${d.openReviews} open`,
    ),
    c(
      "data:load-test",
      "no synthetic load-test contacts remain",
      d.loadTestContacts === 0,
      "blocker",
      `${d.loadTestContacts} found (source load-test or the +971 50 09 block)`,
    ),
    c(
      "data:admin",
      "the workspace has an active Admin",
      d.adminMembers > 0,
      "blocker",
      `${d.adminMembers} admin member(s)`,
    ),
    c(
      "data:failures",
      "outbound failures in the last 24 h are not climbing",
      d.outboundFailed24h < 50,
      "warning",
      `${d.outboundFailed24h} failed`,
    ),
  ];
}

export function evaluateSignOff(
  problems: string[] | null,
  latestReport: string | null,
  latestOk: boolean | null,
): Check[] {
  const c = mk("Sign-off");
  if (!latestReport)
    return [
      c(
        "signoff:report",
        "a reconciliation report exists (pnpm reconcile)",
        false,
        "blocker",
        "none found in docs/audit",
      ),
    ];
  return [
    c(
      "signoff:report",
      "the latest reconciliation report is ready for sign-off",
      latestOk === true,
      "blocker",
      `${latestReport}: ${latestOk ? "ready" : "NOT READY"}`,
    ),
    c(
      "signoff:signed",
      "the report is signed GO by operations, clinical and engineering",
      !!problems && problems.length === 0,
      "blocker",
      problems === null
        ? "docs/audit/reconciliation-signoff.json missing"
        : problems.join("; ") || "signed",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function summarise(checks: Check[]): { ok: boolean; blockers: number; warnings: number } {
  const blockers = checks.filter((x) => !x.ok && x.severity === "blocker").length;
  const warnings = checks.filter((x) => !x.ok && x.severity === "warning").length;
  return { ok: blockers === 0, blockers, warnings };
}

export function renderPreflight(
  checks: Check[],
  meta: { stage: Stage; generatedAt: string; orgSlug: string },
): string {
  const s = summarise(checks);
  const groups = [...new Set(checks.map((x) => x.group))];
  const mark = (x: Check) =>
    x.ok
      ? "PASS"
      : x.severity === "blocker"
        ? "**FAIL**"
        : x.severity === "warning"
          ? "WARN"
          : "info";
  return [
    `# Cut-over preflight — ${meta.stage} — ${meta.generatedAt}`,
    "",
    `- Workspace: \`${meta.orgSlug}\``,
    `- Verdict: **${s.ok ? "GO" : "NO-GO"}** (${s.blockers} blocker(s), ${s.warnings} warning(s))`,
    "- Read-only: this run changed nothing in Pulse, Meta, Unite, Airtable, Make or Sanoflow.",
    "",
    ...groups.flatMap((g) => [
      `## ${g}`,
      "",
      "| Check | Result | Detail |",
      "|---|---|---|",
      ...checks
        .filter((x) => x.group === g)
        .map((x) => `| ${x.name} | ${mark(x)} | ${x.detail.replace(/\|/g, "/")} |`),
      "",
    ]),
  ].join("\n");
}
