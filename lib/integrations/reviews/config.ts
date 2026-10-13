import type { Config } from "@/lib/integrations/accounts";

/** The non-secret settings of review requests. The template and its variable map are set by the review panel, not the generic form. */
export type ReviewConfig = {
  delayMinutes: number;
  sendFrom: string;
  sendTo: string;
  capDays: number;
  templateId: string | null;
  /** {"body.1": "first_name", ...}: which value fills which template variable. */
  variableMap: Record<string, string>;
};

export const REVIEW_VALUE_SOURCES = [
  { key: "first_name", label: "First name of the person receiving the message" },
  { key: "patient_first_name", label: "First name of the patient" },
  { key: "clinic_name", label: "Clinic or location name" },
  { key: "review_link", label: "The Google review link" },
] as const;
export type ReviewValueSource = (typeof REVIEW_VALUE_SOURCES)[number]["key"];

/** Review requests are never sent later than this after the visit ended (a stalled queue must not ask a week later). */
export const MAX_REVIEW_AGE_MS = 3 * 24 * 3_600_000;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function parseReviewVariableMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && REVIEW_VALUE_SOURCES.some((s) => s.key === v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function readReviewConfig(config: Config): ReviewConfig {
  const from =
    typeof config.send_from === "string" && HHMM.test(config.send_from)
      ? config.send_from
      : "09:00";
  const to =
    typeof config.send_to === "string" && HHMM.test(config.send_to) ? config.send_to : "20:00";
  // A window that closes before it opens would never send: fall back to the defaults.
  const ok = to > from;
  return {
    delayMinutes: int(config.delay_minutes, 120, 15, 4320),
    sendFrom: ok ? from : "09:00",
    sendTo: ok ? to : "20:00",
    capDays: int(config.cap_days, 90, 7, 730),
    templateId:
      typeof config.template_id === "string" && config.template_id ? config.template_id : null,
    variableMap: parseReviewVariableMap(config.variable_map),
  };
}
