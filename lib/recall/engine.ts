import "server-only";

import { formatInTimeZone } from "date-fns-tz";

import { isMarketingCategory, classifyRecipient } from "@/lib/campaigns/recipients";
import { loadClinicalSettings } from "@/lib/clinical/engine";
import {
  ageOn,
  birthdayBand,
  birthdayMonthDays,
  decideRecallSend,
  parseBands,
  parseGroups,
  parseVisitGapRule,
  primaryChronicGroup,
  resolveSendMode,
  templateForSegment,
  type RecallTemplateRow,
  type SendMode,
} from "@/lib/clinical/recall";
import { interpolate } from "@/lib/flow-engine/interpolate";
import { orgTimezone } from "@/lib/flow-engine/scope";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type Programme = Tables<"recall_programmes">;

export type RunSummary = {
  runId: string;
  programmeKey: string;
  sendMode: SendMode;
  dryRun: boolean;
  gateOpen: boolean;
  scanned: number;
  queued: number;
  skipped: Record<string, number>;
  bySegment: Record<string, number>;
  note?: string;
};

const PAGE = 200;
const MAX_SCAN = 2000;

type Candidate = {
  contactId: string;
  segment: string | null;
  skip?: string;
  cycleKey: string;
  lastVisitDate?: string;
  daysSince?: number;
};

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

/**
 * One run of one programme. Everything deterministic about eligibility is a SQL candidate query;
 * the judgement calls (mapped template, approvals, the clinical gate) are the pure rules in
 * lib/clinical/recall.ts. Skips are counted, not stored: only real sends use up a patient's cycle,
 * so a closed gate or an unmapped template never costs anyone their recall.
 */
export async function runProgramme(
  admin: AdminClient,
  programme: Programme,
  o: { trigger: "schedule" | "manual" | "check"; now?: Date } = { trigger: "manual" },
): Promise<RunSummary> {
  if (programme.eligibility === "managed")
    throw new Error("This programme is run by another engine.");
  const now = o.now ?? new Date();
  const orgId = programme.org_id;
  const [tz, settings] = await Promise.all([
    orgTimezone(admin, orgId),
    loadClinicalSettings(admin, orgId),
  ]);
  const today = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const sendMode = resolveSendMode(
    programme.send_mode_override,
    settings.value("recall_send_mode"),
  );
  const clinical = programme.kind === "chronic";
  const gateOpen = settings.messagingEnabled();
  const dryRun = o.trigger === "check" || (clinical && !gateOpen);

  if (o.trigger === "schedule") {
    const since = new Date(now.getTime() - 55_000).toISOString();
    const { count } = await admin
      .from("recall_runs")
      .select("id", { count: "exact", head: true })
      .eq("programme_id", programme.id)
      .eq("trigger", "schedule")
      .gte("started_at", since);
    if ((count ?? 0) > 0)
      return emptySummary(programme, sendMode, dryRun, gateOpen, "already ran this minute");
  }

  const { data: run, error: runErr } = await admin
    .from("recall_runs")
    .insert({
      org_id: orgId,
      programme_id: programme.id,
      trigger: o.trigger,
      send_mode: sendMode,
      dry_run: dryRun,
      gate_open: gateOpen,
      started_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (runErr || !run) throw new Error(`recall run: ${runErr?.code}`);

  const summary: RunSummary = {
    runId: run.id,
    programmeKey: programme.key,
    sendMode,
    dryRun,
    gateOpen,
    scanned: 0,
    queued: 0,
    skipped: {},
    bySegment: {},
  };
  let error: string | null = null;
  try {
    await scan(admin, programme, { now, today, tz, settings, sendMode, gateOpen, dryRun, summary });
    if (dryRun && clinical && !gateOpen && o.trigger !== "check")
      summary.note = "Clinical messaging is not signed off: counted only, nothing was queued.";
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 300) : "failed";
    throw e;
  } finally {
    await admin
      .from("recall_runs")
      .update({
        finished_at: new Date().toISOString(),
        scanned: summary.scanned,
        queued: summary.queued,
        skipped: summary.skipped as Json as NonNullable<Json>,
        by_segment: summary.bySegment as Json as NonNullable<Json>,
        error,
      })
      .eq("id", run.id);
  }
  return summary;
}

function emptySummary(
  p: Programme,
  sendMode: SendMode,
  dryRun: boolean,
  gateOpen: boolean,
  note: string,
): RunSummary {
  return {
    runId: "",
    programmeKey: p.key,
    sendMode,
    dryRun,
    gateOpen,
    scanned: 0,
    queued: 0,
    skipped: {},
    bySegment: {},
    note,
  };
}

type Ctx = {
  now: Date;
  today: string;
  tz: string;
  settings: Awaited<ReturnType<typeof loadClinicalSettings>>;
  sendMode: SendMode;
  gateOpen: boolean;
  dryRun: boolean;
  summary: RunSummary;
};

async function scan(admin: AdminClient, p: Programme, c: Ctx): Promise<void> {
  const orgId = p.org_id;
  const testOnly = c.sendMode === "test";
  const config = (p.config ?? {}) as Record<string, unknown>;

  // Template map with the Meta / clinical approval state of each mapped template.
  const { data: rows } = await admin
    .from("recall_programme_templates")
    .select("id, segment_key, wa_template_id, active, variables_map")
    .eq("programme_id", p.id);
  const templateRows: RecallTemplateRow[] = (rows ?? []).map((r) => ({
    id: r.id,
    segmentKey: r.segment_key,
    waTemplateId: r.wa_template_id,
    active: r.active,
  }));
  const waIds = [
    ...new Set(templateRows.map((r) => r.waTemplateId).filter((x): x is string => !!x)),
  ];
  const { data: wa } = waIds.length
    ? await admin
        .from("wa_templates")
        .select("id, name, status, category, components, waba_id, channel_id, clinical_approval")
        .eq("org_id", orgId)
        .in("id", waIds)
    : { data: [] };
  const waById = new Map((wa ?? []).map((t) => [t.id, t]));
  const mapById = new Map(
    (rows ?? []).map((r) => [r.id, r.variables_map as Record<string, string>]),
  );

  const bands = parseBands(config);
  const rule = parseVisitGapRule(config);
  const minDays =
    p.eligibility === "chronic"
      ? settings_num(c.settings, "chronic_recall_min_days")
      : rule.minDays;
  const year = c.today.slice(0, 4);

  let offset = 0;
  let wouldSend = 0;
  const done = () => (c.dryRun ? wouldSend : c.summary.queued) >= p.max_per_run;
  while (!done() && c.summary.scanned < MAX_SCAN) {
    const page = await candidates(admin, p, {
      today: c.today,
      testOnly,
      minDays,
      rule,
      year,
      offset,
    });
    if (page.length === 0) break;
    c.summary.scanned += page.length;

    const { data: contacts } = await admin
      .from("contacts")
      .select(
        "id, first_name, last_name, phone_e164, wa_bsuid, promotions_opt_in, stop_marketing, deleted_at, gender, dob",
      )
      .eq("org_id", orgId)
      .in(
        "id",
        page.map((x) => x.contactId),
      );
    const byId = new Map((contacts ?? []).map((x) => [x.id, x]));

    let queuedThisPage = 0;
    for (const cand of page) {
      if (done()) break;
      const contact = byId.get(cand.contactId);
      const skip = (reason: string) => bump(c.summary.skipped, reason);
      if (!contact) {
        skip("contact_gone");
        continue;
      }
      let segment = cand.segment;
      if (p.eligibility === "birthday") {
        const band = birthdayBand(
          bands,
          contact.gender,
          contact.dob ? ageOn(contact.dob, c.today) : Number.NaN,
        );
        if (!band) {
          skip("band_not_covered");
          continue;
        }
        segment = band;
      }
      if (!segment) {
        skip(cand.skip ?? "no_segment");
        continue;
      }
      const row = templateForSegment(templateRows, segment);
      if (!row) {
        skip("no_template");
        continue;
      }
      const tpl = waById.get(row.waTemplateId!);
      if (!tpl) {
        skip("no_template");
        continue;
      }
      const decision = decideRecallSend({
        kind: p.kind,
        gateOpen: c.gateOpen,
        templateMetaStatus: tpl.status,
        templateClinicalApproval: tpl.clinical_approval,
      });
      if (!decision.allow) {
        skip(decision.reason);
        continue;
      }
      const recipient = classifyRecipient(contact, {
        marketing: isMarketingCategory(tpl.category) || p.requires_marketing_opt_in,
      });
      if (recipient) {
        skip(recipient);
        continue;
      }
      const values: Record<string, string> = {};
      const scope = {
        contact: {
          first_name: contact.first_name,
          last_name: contact.last_name,
          full_name: `${contact.first_name} ${contact.last_name}`.trim(),
        },
      };
      for (const [k, v] of Object.entries(mapById.get(row.id) ?? {}))
        values[k] = interpolate(String(v), scope, { timezone: c.tz });
      const components = tpl.components as unknown as MetaTemplateComponent[];
      const preview = renderTemplatePreview(components, values);
      if (preview.missing.length) {
        skip("template_variables_missing");
        continue;
      }

      if (c.dryRun) {
        bump(c.summary.bySegment, segment);
        wouldSend++;
        continue;
      }

      const channelId = await pickChannel(admin, orgId, p.channel_id, tpl.waba_id, tpl.channel_id);
      if (!channelId) {
        skip("no_active_channel");
        continue;
      }
      const { data: send, error } = await admin
        .from("recall_sends")
        .insert({
          org_id: orgId,
          programme_id: p.id,
          contact_id: contact.id,
          cycle_key: cand.cycleKey,
          segment_key: segment,
          template_row_id: row.id,
          send_mode: c.sendMode,
          last_visit_date_at_send: cand.lastVisitDate ?? null,
          days_since_last_visit_at_send: cand.daysSince ?? null,
        })
        .select("id")
        .single();
      if (error || !send) {
        skip(error?.code === "23505" ? "already_sent" : "could_not_record");
        continue;
      }
      try {
        const conversation = await ensureConversation(admin, orgId, contact.id, channelId);
        const message = await queueOutbound(admin, {
          orgId,
          conversationId: conversation.id,
          spec: { type: "template", template_id: tpl.id, values },
          body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
          sentByUserId: null,
          priority: false, // programmes ride the bulk lane; live chat keeps outbound_priority
        });
        await admin.from("recall_sends").update({ message_id: message.id }).eq("id", send.id);
        c.summary.queued++;
        queuedThisPage++;
        bump(c.summary.bySegment, segment);
      } catch (e) {
        // The row would otherwise block this patient's cycle with nothing sent.
        await admin.from("recall_sends").update({ status: "cancelled" }).eq("id", send.id);
        skip("queue_failed");
        console.error("[recall] queue failed", {
          programme: p.key,
          message: e instanceof Error ? e.name : "unknown",
        });
      }
    }
    // Queued patients drop out of the next page's results, so only the rest move the window.
    offset += page.length - queuedThisPage;
    if (page.length < PAGE) break;
  }
}

function settings_num(s: Ctx["settings"], key: string): number | null {
  const v = s.num(key);
  return v === undefined ? null : Math.floor(v);
}

async function candidates(
  admin: AdminClient,
  p: Programme,
  q: {
    today: string;
    testOnly: boolean;
    minDays: number | null;
    rule: ReturnType<typeof parseVisitGapRule>;
    year: string;
    offset: number;
  },
): Promise<Candidate[]> {
  const base = {
    p_org: p.org_id,
    p_programme: p.id,
    p_limit: PAGE,
    p_offset: q.offset,
    p_test_only: q.testOnly,
  };
  if (p.eligibility === "chronic") {
    const { data, error } = await admin.rpc("recall_chronic_candidates", {
      ...base,
      p_min_days: q.minDays,
      p_today: q.today,
      p_need_consent: p.requires_clinical_consent,
    });
    if (error) throw new Error(`recall candidates: ${error.code}`);
    return (data ?? []).map((r) => ({
      contactId: r.contact_id,
      segment: primaryChronicGroup(parseGroups(r.groups)),
      cycleKey: r.last_visit_date,
      lastVisitDate: r.last_visit_date,
      daysSince: r.days_since,
    }));
  }
  if (p.eligibility === "birthday") {
    const { data, error } = await admin.rpc("recall_birthday_candidates", {
      ...base,
      p_md: birthdayMonthDays(q.today),
      p_cycle: q.year,
      p_need_optin: p.requires_marketing_opt_in,
    });
    if (error) throw new Error(`recall candidates: ${error.code}`);
    return (data ?? []).map((r) => ({ contactId: r.contact_id, segment: "", cycleKey: q.year }));
  }
  const { data, error } = await admin.rpc("recall_visit_gap_candidates", {
    ...base,
    p_min_days: q.rule.minDays,
    p_max_days: q.rule.maxDays,
    p_gender: q.rule.gender,
    p_min_age: q.rule.minAge,
    p_max_age: q.rule.maxAge,
    p_today: q.today,
    p_once: p.repeat_policy === "once",
    p_need_optin: p.requires_marketing_opt_in,
    p_need_consent: p.requires_clinical_consent,
  });
  if (error) throw new Error(`recall candidates: ${error.code}`);
  return (data ?? []).map((r) => ({
    contactId: r.contact_id,
    segment: "*",
    cycleKey: p.repeat_policy === "once" ? "once" : r.last_visit_date,
    lastVisitDate: r.last_visit_date,
    daysSince: r.days_since,
  }));
}

/** Send-from number: the programme's own, else the template's, else any active number on its WABA. */
async function pickChannel(
  admin: AdminClient,
  orgId: string,
  programmeChannel: string | null,
  wabaId: string | null,
  templateChannel: string | null,
): Promise<string | null> {
  let q = admin.from("channels").select("id, waba_id").eq("org_id", orgId).eq("status", "active");
  if (wabaId) q = q.eq("waba_id", wabaId);
  const { data } = await q;
  const ids = (data ?? []).map((c) => c.id);
  return (
    [programmeChannel, templateChannel].find((c): c is string => !!c && ids.includes(c)) ??
    ids[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Delivery status
// ---------------------------------------------------------------------------

const MESSAGE_TO_SEND: Record<string, string> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
};
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/** Copies message delivery status onto recall_sends (status only moves forward; failed is final). */
export async function syncRecallSends(admin: AdminClient, limit = 500): Promise<number> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await admin
    .from("recall_sends")
    .select("id, status, sent_at, messages!recall_sends_message_id_fkey(status, at)")
    .in("status", ["queued", "sent", "delivered"])
    .not("message_id", "is", null)
    .gte("queued_at", since)
    .limit(limit);
  let changed = 0;
  for (const s of data ?? []) {
    const m = s.messages as { status: string; at: string } | null;
    const next = m ? MESSAGE_TO_SEND[m.status] : undefined;
    if (!m || !next || next === s.status) continue;
    if (next !== "failed" && (RANK[next] ?? 0) <= (RANK[s.status] ?? 0)) continue;
    await admin
      .from("recall_sends")
      .update({ status: next, sent_at: s.sent_at ?? (next === "failed" ? null : m.at) })
      .eq("id", s.id);
    changed++;
  }
  return changed;
}
