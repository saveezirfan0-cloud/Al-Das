/**
 * pnpm cutover:preflight — read-only go/no-go check before and after moving a WhatsApp number (Phase 11).
 *
 *   pnpm cutover:preflight --org <slug> --stage pre-cutover  [--number <phone_number_id>] [--skip-graph]
 *   pnpm cutover:preflight --org <slug> --stage post-cutover --number <phone_number_id>
 *   add --report docs/audit/preflight-<name>.md to save the result
 *
 * Reads: environment, Pulse database (counts, queue depth, cron status), docs/audit reconciliation files, and —
 * unless --skip-graph — GET requests to the Meta Graph API for the phone number and the WABA's subscribed apps.
 * Writes nothing anywhere. Never calls Unite, Airtable, Make or Sanoflow. Exit code 1 = NO-GO.
 */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import {
  evaluateChannels,
  evaluateData,
  evaluateEnv,
  evaluateQueues,
  evaluateSignOff,
  renderPreflight,
  summarise,
  type Check,
  type ChannelFacts,
  type CronStatus,
  type QueueMetric,
  type Stage,
} from "../lib/cutover/preflight";
import { checkSignOff, REQUIRED_SIGNOFF_ROLES } from "../lib/migration/reconcile";
import { adminFromEnv, parseArgs, resolveOrg } from "./import/common";

const AUDIT_DIR = path.join(process.cwd(), "docs/audit");

function latestReconciliation(): { report: string; ok: boolean } | null {
  if (!fs.existsSync(AUDIT_DIR)) return null;
  const files = fs
    .readdirSync(AUDIT_DIR)
    .filter((f) => /^reconciliation-\d.*\.json$/.test(f))
    .sort();
  const last = files.at(-1);
  if (!last) return null;
  const j = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, last), "utf8")) as {
    report: string;
    ok: boolean;
  };
  return { report: j.report, ok: j.ok };
}

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const stage = (opts.stage ?? "pre-cutover") as Stage;
  if (stage !== "pre-cutover" && stage !== "post-cutover")
    throw new Error("--stage must be pre-cutover or post-cutover");
  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);
  const checks: Check[] = [];

  // --- environment -------------------------------------------------------
  checks.push(...evaluateEnv(process.env));

  // --- queues, cron, dead letters ----------------------------------------
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const [{ data: metrics }, { count: dead }, { count: stale }, cronRes] = await Promise.all([
    admin.rpc("job_queue_metrics"),
    admin.from("dead_letters").select("id", { count: "exact", head: true }).is("resolved_at", null),
    admin
      .from("webhook_events_in")
      .select("id", { count: "exact", head: true })
      .is("processed_at", null)
      .lt("received_at", fiveMinAgo),
    admin.rpc("job_cron_status"),
  ]);
  checks.push(
    ...evaluateQueues(
      ((metrics ?? []) as unknown as QueueMetric[]).map((m) => ({
        queue_name: m.queue_name,
        queue_length: Number(m.queue_length),
        oldest_msg_age_sec: m.oldest_msg_age_sec,
      })),
      dead ?? 0,
      stale ?? 0,
      cronRes.error ? null : ((cronRes.data ?? []) as unknown as CronStatus[]),
    ),
  );

  // --- channels ----------------------------------------------------------
  const { data: channelRows } = await admin
    .from("channels")
    .select(
      "id, name, phone_number_id, waba_id, status, quality_rating, last_synced_at, send_rate_per_sec",
    )
    .eq("org_id", org.id);
  const rows = (channelRows ?? []).filter((c) => !opts.number || c.phone_number_id === opts.number);
  if (opts.number && rows.length === 0)
    throw new Error(`no channel with phone_number_id ${opts.number} in ${org.slug}`);

  const facts: ChannelFacts[] = [];
  for (const ch of rows) {
    const [{ data: secret }, { count: total }, { count: approved }] = await Promise.all([
      admin.from("channel_secrets").select("channel_id").eq("channel_id", ch.id).maybeSingle(),
      admin
        .from("wa_templates")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", ch.id),
      admin
        .from("wa_templates")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", ch.id)
        .eq("status", "APPROVED"),
    ]);
    let meta: ChannelFacts["meta"] = null;
    if (!flags.has("skip-graph")) {
      try {
        const { clientForChannel } = await import("../lib/whatsapp/channel");
        const client = await clientForChannel(admin, ch);
        const [phone, subs] = await Promise.all([
          client.getPhoneNumber(["id", "status", "quality_rating"]),
          client.getSubscribedApps(),
        ]);
        meta = {
          reachable: true,
          subscribedAppIds: subs.data.map((a) => a.whatsapp_business_api_data.id),
          subscribedAppNames: subs.data.map(
            (a) => a.whatsapp_business_api_data.name ?? a.whatsapp_business_api_data.id,
          ),
          phoneStatus: phone.status,
        };
      } catch (err) {
        const { redactText } = await import("../lib/redact");
        meta = {
          reachable: false,
          error: redactText(err, 160),
          subscribedAppIds: [],
          subscribedAppNames: [],
        };
      }
    }
    facts.push({
      phoneNumberId: ch.phone_number_id,
      name: ch.name,
      status: ch.status,
      qualityRating: ch.quality_rating,
      lastSyncedAt: ch.last_synced_at,
      hasOwnToken: !!secret,
      templateCount: total ?? 0,
      approvedTemplateCount: approved ?? 0,
      sendRatePerSec: ch.send_rate_per_sec,
      meta,
    });
  }
  checks.push(
    ...evaluateChannels(facts, stage, {
      metaAppId: process.env.META_APP_ID,
      envTokenSet: !!process.env.META_SYSTEM_USER_TOKEN,
    }),
  );

  // --- data --------------------------------------------------------------
  const { data: snap, error: snapErr } = await admin.rpc("reconcile_snapshot", {
    p_org_id: org.id,
  });
  if (snapErr || !snap)
    throw new Error(
      `reconcile_snapshot failed (is migration 20261009000800 applied?): ${snapErr?.message ?? "no data"}`,
    );
  const s = snap as unknown as { contacts_live: number; reviews_open: Record<string, number> };
  const [{ count: loadTest }, { count: admins }, { count: failed24 }] = await Promise.all([
    // synthetic recipients: source 'load-test', or any number in the reserved fake block +971 50 09xx xxx
    admin
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .or("source.eq.load-test,phone_e164.like.*9715009*"),
    admin
      .from("memberships")
      .select("id, roles!inner(name)", { count: "exact", head: true })
      .eq("org_id", org.id)
      .eq("status", "active")
      .eq("roles.name", "Admin"),
    admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .eq("direction", "out")
      .eq("status", "failed")
      .gte("at", new Date(Date.now() - 86_400_000).toISOString()),
  ]);
  checks.push(
    ...evaluateData({
      openReviews: Object.values(s.reviews_open ?? {}).reduce((a, b) => a + Number(b), 0),
      contactsLive: Number(s.contacts_live ?? 0),
      loadTestContacts: loadTest ?? 0,
      adminMembers: admins ?? 0,
      outboundFailed24h: failed24 ?? 0,
    }),
  );

  // --- reconciliation sign-off ---------------------------------------------
  const latest = latestReconciliation();
  let problems: string[] | null = null;
  const signFile = path.join(AUDIT_DIR, "reconciliation-signoff.json");
  if (latest && fs.existsSync(signFile)) {
    problems = checkSignOff(JSON.parse(fs.readFileSync(signFile, "utf8")), latest.report, [
      ...REQUIRED_SIGNOFF_ROLES,
    ]);
  }
  checks.push(...evaluateSignOff(problems, latest?.report ?? null, latest?.ok ?? null));

  const md = renderPreflight(checks, {
    stage,
    generatedAt: new Date().toISOString(),
    orgSlug: org.slug,
  });
  console.log(md);
  if (opts.report) {
    fs.writeFileSync(opts.report, md + "\n");
    console.log(`report → ${opts.report}`);
  }
  if (!summarise(checks).ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
