import "server-only";

import { serverEnv } from "@/lib/env";
import {
  bumpUsage,
  dbBreakerStore,
  dbCallSink,
  loadAccount,
  readConfig,
  readSecrets,
  recordFailure,
  recordOk,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { createCapiClient, type CapiClient } from "@/lib/integrations/capi/client";
import { readCapiConfig, type CapiConfig } from "@/lib/integrations/capi/config";
import { capiConsent, withinAttributionWindow } from "@/lib/integrations/capi/consent";
import {
  buildCapiEvent,
  capiEventId,
  MAX_EVENT_AGE_MS,
  type CapiEventName,
} from "@/lib/integrations/capi/event";
import { enqueue } from "@/lib/jobs/enqueue";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * Ad attribution and the Conversions API, server side.
 *
 *   captureAttribution   inbound WhatsApp message with a referral (click id) -> ad_attributions (only while the integration is on),
 *                        and in "send events" mode a Contact event
 *   queueCapiEvent       one row per event (deterministic id, so a repeat is a no-op) + a message on the capi_events queue
 *   processCapiEvent     the queue handler: re-checks everything (switch, training, consent, window, age), builds the payload with
 *                        buildCapiEvent and sends it through the shared client. 429/5xx/timeouts are retried by the queue with back-off
 *   sweepCapi            Lead (enquiries) and Schedule (bookings) for attributed patients, after the integration was switched on
 */

export type CapiQueueOutcome =
  "queued" | "duplicate" | "off" | "report_only" | "training" | `skipped:${string}`;

export type CapiProcessOutcome = "sent" | "retry" | "failed" | "skipped" | "not_queued";

const PERSON =
  "id, phone_e164, email, promotions_opt_in, stop_marketing, deleted_at, erased_at, merged_into_id";

/** The configured client with call logging and the stored breaker, or null while credentials are missing. */
export function buildCapiClientFor(admin: AdminClient, account: AccountRow): CapiClient | null {
  const cfg = readCapiConfig(readConfig(account));
  const secrets = readSecrets(account);
  if (!cfg.datasetId || !secrets.access_token) return null;
  return createCapiClient({
    datasetId: cfg.datasetId,
    accessToken: secrets.access_token,
    graphVersion: cfg.graphVersion ?? serverEnv().META_GRAPH_VERSION,
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "meta_capi"),
  });
}

type Referral = {
  ctwaClid: string;
  sourceId: string | null;
  sourceType: string | null;
  headline: string | null;
};

/** Reads the three ids out of a WhatsApp referral object and nothing else (no ad body, link or media). */
export function parseReferral(raw: unknown): Referral | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const clid = typeof r.ctwa_clid === "string" ? r.ctwa_clid.trim() : "";
  if (!clid || clid.length > 500 || /[\s\u0000-\u001f]/.test(clid)) return null;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  return {
    ctwaClid: clid,
    sourceId: text(r.source_id, 100),
    sourceType: text(r.source_type, 20),
    headline: text(r.headline, 200),
  };
}

export async function captureAttribution(
  admin: AdminClient,
  a: {
    orgId: string;
    contactId: string;
    conversationId: string;
    channelId: string;
    wabaId: string | null;
    referral: unknown;
    at: Date;
  },
): Promise<"captured" | "known" | "off" | "no_click_id"> {
  const ref = parseReferral(a.referral);
  if (!ref) return "no_click_id";
  const account = await loadAccount(admin, a.orgId, "meta_capi");
  if (!account?.enabled) return "off";
  const { data: inserted, error } = await admin
    .from("ad_attributions")
    .upsert(
      {
        org_id: a.orgId,
        contact_id: a.contactId,
        conversation_id: a.conversationId,
        channel_id: a.channelId,
        waba_id: a.wabaId,
        ctwa_clid: ref.ctwaClid,
        source_id: ref.sourceId,
        source_type: ref.sourceType,
        headline: ref.headline,
        clicked_at: a.at.toISOString(),
      },
      { onConflict: "org_id,ctwa_clid", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`attribution insert failed: ${error.code ?? "error"}`);
  const id = inserted?.[0]?.id;
  if (!id) return "known";
  await bumpUsage(admin, a.orgId, "meta_capi", "attributions");
  await queueCapiEvent(admin, {
    orgId: a.orgId,
    attributionId: id,
    eventName: "Contact",
    subjectId: id,
    eventTime: a.at,
  });
  return "captured";
}

/** Hook wrapper for the inbound job: capturing an ad click must never fail the webhook that carries the message. */
export async function captureAttributionSafely(
  admin: AdminClient,
  a: Parameters<typeof captureAttribution>[1],
): Promise<void> {
  try {
    await captureAttribution(admin, a);
  } catch (err) {
    console.error("[capi] could not record an ad click", { error: redactText(err, 120) });
  }
}

export async function queueCapiEvent(
  admin: AdminClient,
  a: {
    orgId: string;
    attributionId: string;
    eventName: CapiEventName;
    /** The attribution, enquiry or appointment the event is about (only its hash leaves Pulse, as the event id). */
    subjectId: string;
    eventTime: Date;
    now?: Date;
  },
): Promise<CapiQueueOutcome> {
  const now = a.now ?? new Date();
  const account = await loadAccount(admin, a.orgId, "meta_capi");
  if (!account?.enabled) return "off";
  const cfg = readCapiConfig(readConfig(account));
  if (cfg.mode !== "send_events") return "report_only";
  if (await isTrainingOrg(admin, a.orgId)) {
    await bumpUsage(admin, a.orgId, "meta_capi", "blocked_training");
    return "training";
  }
  const { data: attribution } = await admin
    .from("ad_attributions")
    .select("id, contact_id, clicked_at")
    .eq("id", a.attributionId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!attribution) return "skipped:no_attribution";

  const { data: person } = attribution.contact_id
    ? await admin
        .from("contacts")
        .select(PERSON)
        .eq("id", attribution.contact_id)
        .eq("org_id", a.orgId)
        .maybeSingle()
    : { data: null };
  const consent = capiConsent(cfg.consentBasis, person);
  let skip: string | null = consent.ok ? null : consent.reason;
  if (
    !skip &&
    !withinAttributionWindow(new Date(attribution.clicked_at), a.eventTime, cfg.windowDays)
  )
    skip = "outside_window";
  if (!skip && now.getTime() - a.eventTime.getTime() > MAX_EVENT_AGE_MS) skip = "too_old";

  const { data: inserted, error } = await admin
    .from("capi_events")
    .upsert(
      {
        org_id: a.orgId,
        attribution_id: attribution.id,
        event_name: a.eventName,
        event_id: capiEventId(a.orgId, a.eventName, a.subjectId),
        subject_id: a.subjectId,
        event_time: a.eventTime.toISOString(),
        status: skip ? "skipped" : "queued",
        reason: skip,
        is_test: !!cfg.testEventCode,
      },
      { onConflict: "org_id,event_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`capi event insert failed: ${error.code ?? "error"}`);
  const id = inserted?.[0]?.id;
  if (!id) return "duplicate";
  if (skip) {
    await bumpUsage(admin, a.orgId, "meta_capi", `skipped_${skip}`);
    return `skipped:${skip}`;
  }
  await enqueue("capi_events", { event_row_id: id });
  await bumpUsage(admin, a.orgId, "meta_capi", "queued");
  return "queued";
}

async function finish(
  admin: AdminClient,
  id: string,
  status: "sent" | "failed" | "skipped",
  reason: string | null,
): Promise<void> {
  await admin
    .from("capi_events")
    .update({
      status,
      reason,
      ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    })
    .eq("id", id)
    .eq("status", "queued");
}

export async function processCapiEvent(
  admin: AdminClient,
  rowId: string,
  opts: { readCt: number; client?: CapiClient; now?: Date },
): Promise<CapiProcessOutcome> {
  const now = opts.now ?? new Date();
  const { data: row } = await admin
    .from("capi_events")
    .select("id, org_id, attribution_id, event_name, event_id, event_time, status, attempts")
    .eq("id", rowId)
    .maybeSingle();
  if (!row || row.status !== "queued") return "not_queued";
  const orgId = row.org_id;

  const account = await loadAccount(admin, orgId, "meta_capi");
  if (!account?.enabled) {
    await finish(admin, row.id, "skipped", "integration_off");
    return "skipped";
  }
  const cfg: CapiConfig = readCapiConfig(readConfig(account));
  if (cfg.mode !== "send_events") {
    await finish(admin, row.id, "skipped", "report_only");
    return "skipped";
  }
  if (await isTrainingOrg(admin, orgId)) {
    await finish(admin, row.id, "skipped", "training");
    return "skipped";
  }
  const { data: attribution } = await admin
    .from("ad_attributions")
    .select("id, contact_id, ctwa_clid, waba_id, clicked_at")
    .eq("id", row.attribution_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!attribution) {
    await finish(admin, row.id, "failed", "no_attribution");
    return "failed";
  }
  const { data: person } = attribution.contact_id
    ? await admin
        .from("contacts")
        .select(PERSON)
        .eq("id", attribution.contact_id)
        .eq("org_id", orgId)
        .maybeSingle()
    : { data: null };
  // Consent is read again now: an opt-out since the event was queued stops it.
  const consent = capiConsent(cfg.consentBasis, person);
  if (!consent.ok) {
    await finish(admin, row.id, "skipped", consent.reason);
    await bumpUsage(admin, orgId, "meta_capi", `skipped_${consent.reason}`);
    return "skipped";
  }
  if (now.getTime() - new Date(row.event_time).getTime() > MAX_EVENT_AGE_MS) {
    await finish(admin, row.id, "skipped", "too_old");
    await bumpUsage(admin, orgId, "meta_capi", "skipped_too_old");
    return "skipped";
  }
  const client = opts.client ?? buildCapiClientFor(admin, account);
  if (!client) {
    await finish(admin, row.id, "failed", "not_configured");
    return "failed";
  }
  const built = buildCapiEvent({
    eventName: row.event_name as CapiEventName,
    eventId: row.event_id,
    eventTime: new Date(row.event_time),
    ctwaClid: attribution.ctwa_clid,
    wabaId: attribution.waba_id ?? "",
    phone: cfg.includePhone ? (person?.phone_e164 ?? null) : null,
    email: null,
    testEventCode: cfg.testEventCode,
  });
  if (!built.ok) {
    await finish(admin, row.id, "failed", built.error);
    return "failed";
  }

  await admin
    .from("capi_events")
    .update({ attempts: row.attempts + 1 })
    .eq("id", row.id);
  const result = await client.sendEvents(built.payload);
  if (result.ok) {
    await finish(admin, row.id, "sent", null);
    await bumpUsage(admin, orgId, "meta_capi", "events_sent");
    await recordOk(admin, orgId, "meta_capi");
    return "sent";
  }
  await recordFailure(admin, orgId, "meta_capi", `Conversions API error ${result.code}`);
  if (result.retryable && opts.readCt < 5) return "retry";
  await finish(admin, row.id, "failed", result.auth ? "auth" : result.code.slice(0, 40));
  await bumpUsage(admin, orgId, "meta_capi", "events_failed");
  return "failed";
}

/**
 * Lead (an enquiry) and Schedule (a booking) for patients who came from an ad, and a Contact event for any click whose inline
 * queueing failed. Only things created after the integration was switched on and in the last 48 hours; a repeat is a no-op.
 */
export async function sweepCapi(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<{ checked: number; queued: number }> {
  const { data: accounts } = await admin
    .from("integration_accounts")
    .select("org_id, enabled_at, config")
    .eq("kind", "meta_capi")
    .eq("enabled", true);
  let checked = 0;
  let queued = 0;
  for (const acc of accounts ?? []) {
    const cfg = readCapiConfig(readConfig(acc as AccountRow));
    if (cfg.mode !== "send_events") continue;
    const since = new Date(
      Math.max(
        now.getTime() - 48 * 3_600_000,
        acc.enabled_at ? new Date(acc.enabled_at).getTime() : now.getTime(),
      ),
    );
    const orgId = acc.org_id;

    // Contact events that were never queued.
    const { data: clicks } = await admin
      .from("ad_attributions")
      .select("id, clicked_at")
      .eq("org_id", orgId)
      .gte("clicked_at", since.toISOString())
      .limit(500);
    const contactEvents = new Set(
      ((clicks ?? []).length
        ? (
            await admin
              .from("capi_events")
              .select("subject_id")
              .eq("org_id", orgId)
              .eq("event_name", "Contact")
              .in(
                "attribution_id",
                (clicks ?? []).map((c) => c.id),
              )
          ).data
        : []
      )?.map((e) => e.subject_id) ?? [],
    );
    for (const c of clicks ?? []) {
      if (contactEvents.has(c.id)) continue;
      checked++;
      const r = await queueCapiEvent(admin, {
        orgId,
        attributionId: c.id,
        eventName: "Contact",
        subjectId: c.id,
        eventTime: new Date(c.clicked_at),
        now,
      });
      if (r === "queued") queued++;
    }

    const [{ data: enquiries }, { data: appointments }] = await Promise.all([
      admin
        .from("enquiries")
        .select("id, contact_id, created_at")
        .eq("org_id", orgId)
        .gte("created_at", since.toISOString())
        .not("contact_id", "is", null)
        .limit(500),
      admin
        .from("appointments")
        .select("id, contact_id, created_at, status")
        .eq("org_id", orgId)
        .gte("created_at", since.toISOString())
        .neq("status", "cancelled")
        .not("contact_id", "is", null)
        .limit(500),
    ]);
    const contactIds = [
      ...new Set(
        [...(enquiries ?? []), ...(appointments ?? [])].map((x) => x.contact_id as string),
      ),
    ];
    if (contactIds.length === 0) continue;
    const { data: attributions } = await admin
      .from("ad_attributions")
      .select("id, contact_id, clicked_at")
      .eq("org_id", orgId)
      .in("contact_id", contactIds)
      .order("clicked_at", { ascending: false });
    const latestBefore = (contactId: string, at: Date) =>
      (attributions ?? []).find(
        (x) => x.contact_id === contactId && new Date(x.clicked_at).getTime() <= at.getTime(),
      );
    const items: Array<{ name: CapiEventName; id: string; contactId: string; at: Date }> = [
      ...(enquiries ?? []).map((e) => ({
        name: "Lead" as const,
        id: e.id,
        contactId: e.contact_id as string,
        at: new Date(e.created_at),
      })),
      ...(appointments ?? []).map((p) => ({
        name: "Schedule" as const,
        id: p.id,
        contactId: p.contact_id as string,
        at: new Date(p.created_at),
      })),
    ];
    for (const it of items) {
      const attribution = latestBefore(it.contactId, it.at);
      if (!attribution) continue;
      checked++;
      const r = await queueCapiEvent(admin, {
        orgId,
        attributionId: attribution.id,
        eventName: it.name,
        subjectId: it.id,
        eventTime: it.at,
        now,
      });
      if (r === "queued") queued++;
    }
  }
  return { checked, queued };
}

export type AdReportRow = {
  source_id: string;
  source_type: string;
  headline: string | null;
  conversations: number;
  patients: number;
  enquiries: number;
  appointments: number;
};

export async function loadAdReport(
  admin: AdminClient,
  orgId: string,
  days: number,
  windowDays: number,
  /** Count clicks from this instant instead (Phase 20i: the cost figures start with the first day that has spend). */
  sinceIso?: string,
): Promise<AdReportRow[]> {
  const since = sinceIso ?? new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await admin.rpc("ad_attribution_report", {
    p_org: orgId,
    p_since: since,
    p_window_days: windowDays,
  });
  if (!Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    source_id: String(r.source_id ?? "unknown"),
    source_type: String(r.source_type ?? "unknown"),
    headline: typeof r.headline === "string" ? r.headline : null,
    conversations: Number(r.conversations) || 0,
    patients: Number(r.patients) || 0,
    enquiries: Number(r.enquiries) || 0,
    appointments: Number(r.appointments) || 0,
  }));
}
