/**
 * Recall engine. One run of one programme:
 *   gate → resolve send mode → read eligibility view → per row: template map, opt-out checks,
 *   INSERT recall_sends FIRST (unique contact+programme+cycle ⇒ re-runs are idempotent) → queue the template.
 *
 * Safety rules (CLAUDE.md 4, 10, 11, 15):
 *  - Test mode is the default; the recipient is always an internal test contact, never the patient.
 *  - Live mode needs an explicit 'live' (programme override or clinical_settings.recall_send_mode, signed off).
 *  - Clinical programmes in Live additionally need clinical_messaging_enabled = true.
 *  - No template mapped / not approved ⇒ skipped_no_template (fail closed, no default template).
 *  - stop_marketing / missing marketing opt-in ⇒ skipped_opted_out.
 *  - Logs carry counts only: no phones, names or message bodies.
 */
import { interpolate } from "@/lib/flow-engine/interpolate";
import {
  ALLOWED_VIEWS,
  CLINICAL_KINDS,
  DEFAULT_TAGS,
  DEFAULT_TEST_SAMPLE,
  type EligibleRow,
  type NewSend,
  type ProgrammeRow,
  type RecallDeps,
  type RunSummary,
  type SendMode,
} from "@/lib/recall/types";

export function effectiveMode(programme: Pick<ProgrammeRow, "send_mode_override">, settingValue: string | null): SendMode {
  const v = (programme.send_mode_override ?? settingValue ?? "").trim().toLowerCase();
  return v === "live" ? "live" : "test"; // anything else, including unsigned / blank, is Test
}

/** `test_recipient_numbers` is a list setting: comma / newline / semicolon separated E.164 numbers. */
export function parseTestNumbers(raw: string | null): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    if (/^\+[1-9][0-9]{6,14}$/.test(part)) out.add(part);
  }
  return [...out];
}

/** `order_by` is data: accept only "<column> asc|desc" over a small allow-list. */
export function parseOrderBy(raw: unknown): { column: string; ascending: boolean } | null {
  if (typeof raw !== "string") return null;
  const m = /^(days_since_last_visit|starts_at|last_visit_date|contact_id)\s+(asc|desc)$/i.exec(raw.trim());
  return m ? { column: m[1]!.toLowerCase(), ascending: m[2]!.toLowerCase() === "asc" } : null;
}

function tagFor(programme: ProgrammeRow, cycleKey: string): string | null {
  const tpl = (typeof programme.config.tag === "string" ? programme.config.tag : null) ?? DEFAULT_TAGS[programme.key] ?? null;
  return tpl ? tpl.replace("{cycle}", cycleKey) : null;
}

export async function runProgramme(deps: RecallDeps, programmeId: string): Promise<RunSummary> {
  const { store } = deps;
  const p = await store.getProgramme(programmeId);
  const empty = (mode: SendMode, blocked?: string): RunSummary => ({
    programme: p?.key ?? "unknown",
    mode,
    blocked,
    listed: 0,
    queued: 0,
    recorded_only: 0,
    skipped_no_template: 0,
    skipped_opted_out: 0,
    excluded: 0,
    already_handled: 0,
    failed: 0,
  });
  if (!p) return empty("test", "programme_not_found");
  if (p.status !== "active") return empty("test", `programme_${p.status}`);
  if (!p.eligibility_view || !ALLOWED_VIEWS.has(p.eligibility_view)) return empty("test", "no_eligibility_view");

  const mode = effectiveMode(p, await store.setting(p.org_id, "recall_send_mode"));
  const summary = empty(mode);

  if (mode === "live" && CLINICAL_KINDS.has(p.kind)) {
    const enabled = (await store.setting(p.org_id, "clinical_messaging_enabled"))?.toLowerCase() === "true";
    if (!enabled) {
      summary.blocked = "clinical_messaging_disabled";
      await store.touchProgramme(p.id, deps.now());
      return summary;
    }
  }

  let testContacts: Array<{ id: string; phone_e164: string }> = [];
  if (mode === "test") {
    const numbers = parseTestNumbers(await store.setting(p.org_id, "test_recipient_numbers"));
    if (numbers.length === 0) {
      summary.blocked = "no_test_recipients";
      await store.touchProgramme(p.id, deps.now());
      return summary;
    }
    testContacts = await store.testContacts(p.org_id, numbers);
    if (testContacts.length === 0) {
      summary.blocked = "no_test_recipients";
      await store.touchProgramme(p.id, deps.now());
      return summary;
    }
  }

  const limit = Math.max(1, Math.min(p.max_per_run, 1000));
  const rows = await store.listEligible(p, limit);
  summary.listed = rows.length;

  const templates = new Map((await store.templateMap(p.id)).filter((t) => t.active).map((t) => [t.segment_key, t]));
  const bump = (created: unknown, key: "excluded" | "skipped_no_template" | "skipped_opted_out") => {
    if (created) summary[key] += 1;
    else summary.already_handled += 1;
  };
  const sampleSize = typeof p.config.test_sample_size === "number" ? p.config.test_sample_size : DEFAULT_TEST_SAMPLE;
  let delivered = 0;

  for (const row of rows) {
    const contact = await store.contact(p.org_id, row.contact_id);
    if (!contact) continue;

    const base: Omit<NewSend, "status" | "template_id" | "legacy_template_ref" | "sent_to_phone_e164" | "notes"> = {
      org_id: p.org_id,
      programme_id: p.id,
      contact_id: row.contact_id,
      cycle_key: row.cycle_key,
      segment_key: row.segment_key,
      send_mode: mode,
      eligible_at: deps.now().toISOString(),
      last_visit_date_at_send: row.last_visit_date ?? null,
      days_since_last_visit_at_send: row.days_since_last_visit ?? null,
      appointment_id: row.appointment_id ?? null,
    };
    const record = async (status: NewSend["status"], extra: Partial<NewSend> = {}) =>
      store.insertSend({ ...base, status, template_id: null, legacy_template_ref: null, sent_to_phone_e164: null, notes: null, ...extra });

    // 1. Exclusions and opt-outs never reach a template lookup.
    if (row.excluded) {
      bump(await record("excluded", { notes: "Matches a reminder exclusion rule" }), "excluded");
      continue;
    }
    if (
      contact.stop_marketing ||
      (p.requires_marketing_opt_in && !contact.promotions_opt_in) ||
      (mode === "live" && p.requires_clinical_consent && !contact.clinical_messaging_consent)
    ) {
      bump(await record("skipped_opted_out"), "skipped_opted_out");
      continue;
    }

    // 2. Template map: segment first, then '*'. A null segment (uncovered band) only matches '*'.
    const map = (row.segment_key ? templates.get(row.segment_key) : undefined) ?? templates.get("*");
    const tpl = map?.wa_template_id ? await store.template(p.org_id, map.wa_template_id) : null;
    if (!map || !tpl || tpl.status !== "APPROVED") {
      const note = !map ? "No template mapped for this segment" : !map.wa_template_id ? "Template not linked yet" : "Template not approved";
      bump(await record("skipped_no_template", { template_id: map?.id ?? null, legacy_template_ref: map?.legacy_sanoflow_template_id ?? null, notes: note }), "skipped_no_template");
      continue;
    }
    if (tpl.category.toUpperCase() === "MARKETING" && !contact.promotions_opt_in) {
      bump(await record("skipped_opted_out", { template_id: map.id, legacy_template_ref: map.legacy_sanoflow_template_id }), "skipped_opted_out");
      continue;
    }

    // 3. Who actually receives it.
    const recipient =
      mode === "test" ? testContacts[(summary.queued + summary.recorded_only) % testContacts.length]! : { id: contact.id, phone_e164: contact.phone_e164 ?? "" };
    const deliver = mode === "live" || delivered < sampleSize;

    // 4. Insert first; a unique-violation means a concurrent / earlier run owns this contact+cycle.
    const send = await record(deliver ? "queued" : "eligible", {
      template_id: map.id,
      legacy_template_ref: map.legacy_sanoflow_template_id,
      sent_to_phone_e164: deliver ? recipient.phone_e164 : null,
      notes: deliver ? null : "Test mode: counted but not delivered (sample cap)",
    });
    if (!send) {
      summary.already_handled++;
      continue;
    }
    if (!deliver) {
      summary.recorded_only++;
      continue;
    }

    const values = renderValues(map.variables_map, contact, row, deps);
    try {
      const sent = await deps.sender.sendTemplate({ orgId: p.org_id, contactId: recipient.id, waTemplateId: tpl.id, values });
      await store.updateSend(send.id, { message_id: sent.messageId, sent_at: deps.now().toISOString() });
      summary.queued++;
      delivered++;
      if (mode === "live") {
        const tag = tagFor(p, row.cycle_key);
        if (tag) await store.tagContact(p.org_id, contact.id, tag);
      }
    } catch (err) {
      await store.updateSend(send.id, { status: "failed", notes: (err instanceof Error ? err.message : "send failed").slice(0, 200) });
      summary.failed++;
    }
  }

  await store.touchProgramme(p.id, deps.now());
  return summary;
}

/** variables_map entries are bare paths with optional filters: "contact.first_name|default:Patient". */
export function renderValues(
  map: Record<string, string>,
  contact: { first_name: string; last_name: string; full_name: string },
  row: EligibleRow,
  deps: Pick<RecallDeps, "timezone">,
): Record<string, string> {
  const scope = {
    contact: { first_name: contact.first_name, last_name: contact.last_name, full_name: contact.full_name },
    appointment: { starts_at: row.starts_at ?? "", doctor_name: row.doctor_name ?? "" },
    recall: { segment: row.segment_key ?? "", cycle: row.cycle_key },
  };
  const out: Record<string, string> = {};
  for (const [k, expr] of Object.entries(map)) {
    out[k] = interpolate(expr.includes("{") ? expr : `{${expr}}`, scope, { timezone: deps.timezone }).text.trim();
  }
  return out;
}
