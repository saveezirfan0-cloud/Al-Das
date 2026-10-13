import "server-only";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import { loadAccount, readConfig, type AccountRow } from "@/lib/integrations/accounts";
import {
  MAX_REVIEW_AGE_MS,
  readReviewConfig,
  type ReviewConfig,
} from "@/lib/integrations/reviews/config";
import {
  reviewDecision,
  visitIsFinished,
  type ReviewSkipReason,
} from "@/lib/integrations/reviews/decision";
import { reviewRunAt, visitEnd } from "@/lib/integrations/reviews/schedule";
import { validateReviewUrl } from "@/lib/integrations/reviews/url";
import {
  firstName,
  reviewValues,
  REVIEW_PROBE_CONTEXT,
  type ReviewValueContext,
} from "@/lib/integrations/reviews/values";
import type { TemplateReadiness } from "@/lib/integrations/readiness";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Google review requests, server side. No Google service is called: the "integration" is a feature flag, a review link per location
 * and an approved WhatsApp template that carries it. Order of guards when a request is processed (everything is read again, nothing
 * is trusted from when it was scheduled):
 *
 *   integration on -> not a training workspace -> visit still completed -> consent and "do not ask" (decision.ts, which has no input
 *   about how the visit went) -> template ready -> a channel -> the cap, claimed atomically in the database -> queueOutbound.
 */

export type ReviewScheduleOutcome =
  "scheduled" | "duplicate" | "off" | "training" | "no_appointment" | "not_finished";

export type ReviewProcessOutcome =
  "queued" | "cap_blocked" | "failed" | "skipped" | "not_scheduled" | "not_due";

type TemplateRow = {
  id: string;
  name: string;
  status: string;
  category: string;
  components: unknown;
  channel_id: string | null;
  waba_id: string | null;
};

export async function loadReviewTemplate(
  admin: AdminClient,
  orgId: string,
  id: string | null,
): Promise<TemplateRow | null> {
  if (!id) return null;
  const { data } = await admin
    .from("wa_templates")
    .select("id, name, status, category, components, channel_id, waba_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

/** How the chosen template looks to the readiness check (shared by the settings page and the send path). */
export function reviewTemplateReadiness(
  template: TemplateRow | null,
  cfg: Pick<ReviewConfig, "variableMap">,
): TemplateReadiness | null {
  if (!template) return null;
  const probe = reviewValues(
    template.components as MetaTemplateComponent[],
    cfg.variableMap,
    REVIEW_PROBE_CONTEXT,
  );
  return {
    status: template.status,
    category: template.category,
    mappedAll: probe.missing.length === 0,
    hasLinkVariable: probe.hasLink,
    unsupported: probe.unsupported.length > 0,
  };
}

/** Locations with a valid review link (for the readiness check and the settings panel). */
export async function countLocationsWithLink(admin: AdminClient, orgId: string): Promise<number> {
  const { data } = await admin
    .from("locations")
    .select("review_url")
    .eq("org_id", orgId)
    .eq("active", true)
    .not("review_url", "is", null);
  return (data ?? []).filter((l) => validateReviewUrl(l.review_url).ok).length;
}

async function pickChannel(
  admin: AdminClient,
  orgId: string,
  template: TemplateRow,
): Promise<string | null> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, waba_id")
    .eq("org_id", orgId)
    .eq("status", "active");
  const ids = (channels ?? [])
    .filter((c) => !template.waba_id || c.waba_id === template.waba_id)
    .map((c) => c.id);
  return template.channel_id && ids.includes(template.channel_id)
    ? template.channel_id
    : (ids[0] ?? null);
}

async function orgTimezone(admin: AdminClient, orgId: string): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
  return data?.timezone ?? "Asia/Dubai";
}

/**
 * Called when a visit is completed or checked out (and by the sweep). Cheap: one row and one scheduled job; nothing is decided
 * about the person yet. Idempotent: one request per appointment.
 */
export async function scheduleReviewRequest(
  admin: AdminClient,
  a: { orgId: string; appointmentId: string; now?: Date },
): Promise<ReviewScheduleOutcome> {
  const now = a.now ?? new Date();
  const account = await loadAccount(admin, a.orgId, "google_reviews");
  if (!account?.enabled) return "off";
  if (await isTrainingOrg(admin, a.orgId)) return "training";
  const cfg = readReviewConfig(readConfig(account));

  const { data: appt } = await admin
    .from("appointments")
    .select(
      "id, org_id, status, checkin_status, contact_id, location_id, ends_at, done_at, checked_out_at, locations(timezone)",
    )
    .eq("id", a.appointmentId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!appt) return "no_appointment";
  if (!visitIsFinished(appt)) return "not_finished";

  const timezone = appt.locations?.timezone ?? (await orgTimezone(admin, a.orgId));
  const end = visitEnd(appt, now);
  const runAt = reviewRunAt(
    end,
    cfg.delayMinutes,
    { timezone, from: cfg.sendFrom, to: cfg.sendTo },
    now,
  );
  const { data: inserted, error } = await admin
    .from("review_requests")
    .upsert(
      {
        org_id: a.orgId,
        appointment_id: appt.id,
        contact_id: appt.contact_id,
        location_id: appt.location_id,
        status: "scheduled",
        run_at: runAt.toISOString(),
        visit_ended_at: end.toISOString(),
      },
      { onConflict: "org_id,appointment_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`review request insert failed: ${error.code ?? "error"}`);
  const id = inserted?.[0]?.id;
  if (!id) return "duplicate";
  await scheduleJob({
    kind: "review.send",
    orgId: a.orgId,
    runAt,
    payload: { request_id: id },
    dedupeKey: `review:${id}`,
  });
  return "scheduled";
}

/** Hook wrapper: never lets a failure here fail the status change or check-in that triggered it. */
export async function scheduleReviewRequestSafely(
  admin: AdminClient,
  a: { orgId: string; appointmentId: string },
): Promise<void> {
  try {
    await scheduleReviewRequest(admin, a);
  } catch (err) {
    console.error("[reviews] could not schedule a review request", {
      error: redactText(err, 120),
    });
  }
}

async function skip(
  admin: AdminClient,
  orgId: string,
  id: string,
  reason: ReviewSkipReason,
  status: "skipped" | "failed" = "skipped",
): Promise<ReviewProcessOutcome> {
  await admin
    .from("review_requests")
    .update({ status, reason, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId)
    .in("status", ["scheduled", "queued"]);
  return status === "failed" ? "failed" : "skipped";
}

const PERSON =
  "id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing, promotions_opt_in, deleted_at, erased_at, merged_into_id, is_test_record, no_review_requests_at";

/** The job: decides and, if allowed, queues the single message. Safe to run twice: the row decides. */
export async function processReviewRequest(
  admin: AdminClient,
  a: { orgId: string; requestId: string; now?: Date; account?: AccountRow | null },
): Promise<ReviewProcessOutcome> {
  const now = a.now ?? new Date();
  const orgId = a.orgId;
  const { data: row } = await admin
    .from("review_requests")
    .select("id, org_id, appointment_id, status, run_at, visit_ended_at")
    .eq("id", a.requestId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!row || row.status !== "scheduled") return "not_scheduled";
  if (new Date(row.run_at).getTime() > now.getTime() + 60_000) return "not_due";

  const account = a.account ?? (await loadAccount(admin, orgId, "google_reviews"));
  if (!account?.enabled) return skip(admin, orgId, row.id, "integration_off");
  if (await isTrainingOrg(admin, orgId)) return skip(admin, orgId, row.id, "training");
  const cfg = readReviewConfig(readConfig(account));

  const { data: appt } = await admin
    .from("appointments")
    .select("id, status, checkin_status, contact_id, location_id, locations(name, review_url)")
    .eq("id", row.appointment_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!appt) return skip(admin, orgId, row.id, "visit_not_completed");

  const { data: patient } = appt.contact_id
    ? await admin
        .from("contacts")
        .select(PERSON)
        .eq("id", appt.contact_id)
        .eq("org_id", orgId)
        .maybeSingle()
    : { data: null };
  const link = patient ? await loadHouseholdLink(admin, orgId, patient.id) : null;
  const target = patient ? resolveRecipient(patient as HouseholdContact, link) : null;
  const { data: recipient } = target
    ? target.recipient.id === patient?.id
      ? { data: patient }
      : await admin
          .from("contacts")
          .select(PERSON)
          .eq("id", target.recipient.id)
          .eq("org_id", orgId)
          .maybeSingle()
    : { data: null };

  const validLink = validateReviewUrl(appt.locations?.review_url);
  const decision = reviewDecision({
    appointment: {
      status: appt.status,
      checkin_status: appt.checkin_status,
      hasPatient: !!appt.contact_id,
    },
    patient,
    recipient: recipient ?? null,
    link: validLink.ok ? validLink.url : null,
    now,
    visitEndedAt: new Date(row.visit_ended_at ?? row.run_at),
    maxAgeMs: MAX_REVIEW_AGE_MS,
  });
  if (!decision.allow) return skip(admin, orgId, row.id, decision.reason);
  if (!patient || !recipient || !target || !validLink.ok)
    return skip(admin, orgId, row.id, "no_recipient");

  const template = await loadReviewTemplate(admin, orgId, cfg.templateId);
  const ready = reviewTemplateReadiness(template, cfg);
  if (
    !template ||
    !ready ||
    ready.status !== "APPROVED" ||
    !ready.mappedAll ||
    !ready.hasLinkVariable ||
    ready.unsupported
  )
    return skip(admin, orgId, row.id, "template_not_ready");
  const channelId = await pickChannel(admin, orgId, template);
  if (!channelId) return skip(admin, orgId, row.id, "no_channel");

  const comps = template.components as MetaTemplateComponent[];
  const ctx: ReviewValueContext = {
    first_name: firstName(recipient.first_name) || "there",
    patient_first_name: firstName(patient.first_name) || "the patient",
    clinic_name: appt.locations?.name ?? "",
    review_link: validLink.url,
  };
  const { values, missing } = reviewValues(comps, cfg.variableMap, ctx);
  const preview = renderTemplatePreview(comps, values);
  if (missing.length || preview.missing.length)
    return skip(admin, orgId, row.id, "template_not_ready");

  // The person asked is recorded first, then the cap is claimed in the database (one request per person per window).
  await admin
    .from("review_requests")
    .update({ recipient_contact_id: recipient.id })
    .eq("id", row.id)
    .eq("org_id", orgId);
  const { data: claim, error: claimError } = await admin.rpc("claim_review_request", {
    p_org: orgId,
    p_request: row.id,
    p_cap_days: cfg.capDays,
  });
  if (claimError) throw new Error(`claim_review_request failed: ${claimError.code ?? "error"}`);
  if (claim === "cap_blocked") return "cap_blocked";
  if (claim !== "claimed") return "not_scheduled";

  try {
    const conversation = await ensureConversation(admin, orgId, recipient.id, channelId);
    const message = await queueOutbound(admin, {
      orgId,
      conversationId: conversation.id,
      spec: { type: "template", template_id: template.id, values },
      body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
      sentByUserId: null,
      priority: false,
    });
    await admin
      .from("review_requests")
      .update({ message_id: message.id })
      .eq("id", row.id)
      .eq("org_id", orgId);
  } catch (err) {
    console.error("[reviews] message could not be queued", { error: redactText(err, 120) });
    // 'failed' no longer counts against the cap: the person was never asked.
    return skip(admin, orgId, row.id, "queue_failed", "failed");
  }
  await addTimelineEvent(admin, {
    orgId,
    contactId: patient.id,
    type: "review.requested",
    actorType: "system",
    payload: { appointment_id: appt.id, request_id: row.id },
  });
  return "queued";
}

/**
 * Safety net for the hooks: completed visits (the Unite sync, another process) that never got a request. Looks only at visits that
 * ended after the integration was switched on and within the last day, so switching it on never asks about the past.
 */
export async function sweepReviewRequests(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<{ checked: number; scheduled: number }> {
  const { data: accounts } = await admin
    .from("integration_accounts")
    .select("org_id, enabled_at")
    .eq("kind", "google_reviews")
    .eq("enabled", true);
  let checked = 0;
  let scheduled = 0;
  for (const acc of accounts ?? []) {
    const since = new Date(
      Math.max(
        now.getTime() - 24 * 3_600_000,
        acc.enabled_at ? new Date(acc.enabled_at).getTime() : now.getTime(),
      ),
    );
    const { data: candidates } = await admin
      .from("appointments")
      .select("id, status, checkin_status, ends_at, done_at, checked_out_at")
      .eq("org_id", acc.org_id)
      .or("status.eq.completed,checkin_status.eq.checked_out")
      .gte("ends_at", new Date(since.getTime() - 24 * 3_600_000).toISOString())
      .lte("ends_at", now.toISOString())
      .order("ends_at", { ascending: false })
      .limit(500);
    const fresh = (candidates ?? []).filter(
      (c) => visitIsFinished(c) && visitEnd(c, now).getTime() >= since.getTime(),
    );
    if (fresh.length === 0) continue;
    const { data: existing } = await admin
      .from("review_requests")
      .select("appointment_id")
      .eq("org_id", acc.org_id)
      .in(
        "appointment_id",
        fresh.map((c) => c.id),
      );
    const have = new Set((existing ?? []).map((e) => e.appointment_id));
    for (const c of fresh) {
      if (have.has(c.id)) continue;
      checked++;
      const r = await scheduleReviewRequest(admin, { orgId: acc.org_id, appointmentId: c.id, now });
      if (r === "scheduled") scheduled++;
    }
  }
  return { checked, scheduled };
}

export type ReviewStats = {
  byStatus: Record<string, number>;
  skippedByReason: Record<string, number>;
  byLocation: Array<{ location: string; queued: number; cap_blocked: number; skipped: number }>;
  notDelivered: number;
};

export async function loadReviewStats(
  admin: AdminClient,
  orgId: string,
  days = 30,
): Promise<ReviewStats> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await admin.rpc("review_request_stats", { p_org: orgId, p_since: since });
  const d = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<
    string,
    unknown
  >;
  const obj = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) out[k] = Number(n) || 0;
    return out;
  };
  return {
    byStatus: obj(d.by_status),
    skippedByReason: obj(d.skipped_by_reason),
    byLocation: Array.isArray(d.by_location)
      ? (d.by_location as Array<Record<string, unknown>>).map((l) => ({
          location: String(l.location ?? ""),
          queued: Number(l.queued) || 0,
          cap_blocked: Number(l.cap_blocked) || 0,
          skipped: Number(l.skipped) || 0,
        }))
      : [],
    notDelivered: Number(d.not_delivered) || 0,
  };
}
