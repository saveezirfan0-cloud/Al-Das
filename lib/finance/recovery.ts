import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Self-pay recovery reminders (pure planning). Who may be reminded, how often, and the values for the mapped template.
 * The send itself (lib/finance/recovery-server.ts) goes through the outbound queue, template only, so the 24-hour window,
 * the per-number rate limit and `training` mode all apply exactly as for any other outbound message.
 *
 * A patient is reminded only when the person who would RECEIVE the message (the patient, or a guardian for a dependant)
 * opted in (promotions_opt_in) and has not stopped marketing, has a WhatsApp identifier, and the invoice is overdue by
 * the configured days with at least the configured balance. Nothing is sent more often than `gapDays`, or more than
 * `maxReminders` times per invoice. All of these are fin_ref_finance_settings values.
 */

export type RecoverySettings = {
  minBalance: number;
  minDaysOverdue: number;
  gapDays: number;
  maxReminders: number;
  batchSize: number;
};

export type BalanceRow = {
  invoice_id: string;
  inv_display_number: string;
  patient_pin: string;
  transaction_date: string;
  branch_code: string | null;
  balance: number;
  days_old: number;
};

export type PriorReminder = {
  invoice_id: string;
  sequence_no: number;
  status: "queued" | "failed";
  created_at: string;
};

export type RecoveryPerson = {
  id: string;
  first_name: string | null;
  phone_e164: string | null;
  wa_bsuid: string | null;
  promotions_opt_in: boolean;
  stop_marketing: boolean;
};

/** Who the reminder for a patient goes to (resolveRecipient decides: the patient, or the guardian of a dependant). */
export type RecoveryTarget = {
  recipient: RecoveryPerson;
  patient: RecoveryPerson;
  viaGuardian: boolean;
};

export type SkipReason =
  | "no_patient_record"
  | "no_whatsapp_id"
  | "no_opt_in"
  | "stop_marketing"
  | "balance_below_minimum"
  | "not_overdue_yet"
  | "reminded_recently"
  | "max_reminders_reached"
  | "batch_full";

export type ReminderPlan = {
  invoiceId: string;
  invoiceNumber: string;
  patientPin: string;
  balance: number;
  daysOld: number;
  sequence: number;
  recipientId: string;
  viaGuardian: boolean;
};

const DAY_MS = 86_400_000;

export function planReminders(input: {
  balances: readonly BalanceRow[];
  priors: readonly PriorReminder[];
  targets: ReadonlyMap<string, RecoveryTarget | null>;
  settings: RecoverySettings;
  now: Date;
}): { plans: ReminderPlan[]; skipped: Array<{ invoiceId: string; reason: SkipReason }> } {
  const { settings, now } = input;
  const sent = new Map<string, PriorReminder[]>();
  for (const p of input.priors) {
    if (p.status !== "queued") continue;
    const list = sent.get(p.invoice_id) ?? [];
    list.push(p);
    sent.set(p.invoice_id, list);
  }
  const plans: ReminderPlan[] = [];
  const skipped: Array<{ invoiceId: string; reason: SkipReason }> = [];
  const skip = (invoiceId: string, reason: SkipReason) => skipped.push({ invoiceId, reason });

  for (const b of input.balances) {
    if (b.balance < Math.max(settings.minBalance, 0.01)) {
      skip(b.invoice_id, "balance_below_minimum");
      continue;
    }
    if (b.days_old < settings.minDaysOverdue) {
      skip(b.invoice_id, "not_overdue_yet");
      continue;
    }
    const prior = sent.get(b.invoice_id) ?? [];
    if (prior.length >= settings.maxReminders) {
      skip(b.invoice_id, "max_reminders_reached");
      continue;
    }
    const last = prior.map((p) => new Date(p.created_at).getTime()).sort((a, c) => c - a)[0];
    if (last !== undefined && now.getTime() - last < settings.gapDays * DAY_MS) {
      skip(b.invoice_id, "reminded_recently");
      continue;
    }
    const target = input.targets.get(b.patient_pin) ?? null;
    if (!target) {
      skip(b.invoice_id, "no_patient_record");
      continue;
    }
    const r = target.recipient;
    if (!r.phone_e164 && !r.wa_bsuid) {
      skip(b.invoice_id, "no_whatsapp_id");
      continue;
    }
    if (r.stop_marketing) {
      skip(b.invoice_id, "stop_marketing");
      continue;
    }
    if (!r.promotions_opt_in) {
      skip(b.invoice_id, "no_opt_in");
      continue;
    }
    if (plans.length >= settings.batchSize) {
      skip(b.invoice_id, "batch_full");
      continue;
    }
    plans.push({
      invoiceId: b.invoice_id,
      invoiceNumber: b.inv_display_number,
      patientPin: b.patient_pin,
      balance: b.balance,
      daysOld: b.days_old,
      sequence: Math.max(0, ...prior.map((p) => p.sequence_no)) + 1,
      recipientId: r.id,
      viaGuardian: target.viaGuardian,
    });
  }
  return { plans, skipped };
}

export const RECOVERY_SOURCES = [
  { key: "first_name", label: "First name of the person receiving the message" },
  { key: "patient_first_name", label: "First name of the patient (differs for a dependant)" },
  { key: "amount_due", label: "Amount due, for example AED 120.00" },
  { key: "invoice_ref", label: "Invoice number" },
  { key: "clinic_name", label: "Clinic name" },
  { key: "days_overdue", label: "Days since the invoice date" },
] as const;
export type RecoverySource = (typeof RECOVERY_SOURCES)[number]["key"];

export type RecoveryValueContext = Record<RecoverySource, string>;

/**
 * Template values from the finance variable map ({"body.1": "first_name", ...}). Only text variables are supported: a
 * template with a media header or a button variable cannot be used (reported in `unsupported`). Every other variable
 * must be mapped, otherwise it is listed in `missing` and nothing is sent.
 */
export function recoveryValues(
  components: MetaTemplateComponent[],
  variableMap: Record<string, string> | null | undefined,
  ctx: RecoveryValueContext,
): { values: Record<string, string>; missing: string[]; unsupported: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const v of templateVariables(components)) {
    if (v.kind !== "text" || v.component === "button") {
      unsupported.push(v.key);
      continue;
    }
    const source = variableMap?.[v.key];
    if (source && (RECOVERY_SOURCES as readonly { key: string }[]).some((s) => s.key === source)) {
      values[v.key] = ctx[source as RecoverySource];
    } else missing.push(v.key);
  }
  return { values, missing, unsupported };
}

/** Why the feature cannot be switched on yet (empty = ready). */
export function recoveryReadiness(input: {
  templateStatus: string | null;
  templateCategory?: string | null;
  mappedAll: boolean;
  toneApprovedHash: string | null;
  currentHash: string | null;
}): string[] {
  const problems: string[] = [];
  if (!input.templateStatus) problems.push("Choose a template.");
  else if (input.templateStatus !== "APPROVED")
    problems.push("The template is not approved by Meta.");
  if (!input.mappedAll) problems.push("Map every template variable to a value.");
  if (!input.toneApprovedHash) problems.push("Finance has not approved the wording yet.");
  else if (input.currentHash && input.toneApprovedHash !== input.currentHash)
    problems.push("The template wording changed after finance approved it. Approve it again.");
  return problems;
}
