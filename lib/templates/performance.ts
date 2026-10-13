/**
 * Template performance (Phase 20d, G8 + the template-rate part of G13). Counts come from our own message rows and
 * Meta's status webhooks (public.report_template_performance): sent, delivered, read, replied within 24 hours,
 * quick-reply clicks and failed. Meta's own template analytics API is NOT called (not built; see the notes).
 * The shaping below is pure and unit-tested; callers run can() first and use the service role.
 */

export type TemplatePerformanceRow = {
  template_id: string;
  name: string;
  language: string;
  category: string;
  messages: number;
  sent: number;
  delivered: number;
  read_count: number;
  replied: number;
  clicked: number;
  failed: number;
  pending: number;
  retries: number;
  from_campaigns: number;
};

export type TemplateRates = {
  /** delivered / sent */
  delivered: number | null;
  /** read / delivered */
  read: number | null;
  /** replied / delivered */
  replied: number | null;
  /** clicked / delivered */
  clicked: number | null;
  /** failed / (sent + failed): what share of the messages that reached a final answer failed */
  failed: number | null;
};

const rate = (n: number, of: number): number | null => (of > 0 ? n / of : null);

export function templateRates(
  r: Pick<
    TemplatePerformanceRow,
    "sent" | "delivered" | "read_count" | "replied" | "clicked" | "failed"
  >,
): TemplateRates {
  return {
    delivered: rate(r.delivered, r.sent),
    read: rate(r.read_count, r.delivered),
    replied: rate(r.replied, r.delivered),
    clicked: rate(r.clicked, r.delivered),
    failed: rate(r.failed, r.sent + r.failed),
  };
}

/** Totals over several templates (the report's KPI row). */
export function sumPerformance(
  rows: readonly TemplatePerformanceRow[],
): Omit<TemplatePerformanceRow, "template_id" | "name" | "language" | "category"> {
  const out = {
    messages: 0,
    sent: 0,
    delivered: 0,
    read_count: 0,
    replied: 0,
    clicked: 0,
    failed: 0,
    pending: 0,
    retries: 0,
    from_campaigns: 0,
  };
  for (const r of rows)
    for (const k of Object.keys(out) as Array<keyof typeof out>) out[k] += Number(r[k] ?? 0);
  return out;
}

/** Normalises the RPC rows (numbers may arrive as strings through some drivers). */
export function toPerformanceRows(raw: unknown): TemplatePerformanceRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: Record<string, unknown>) => ({
    template_id: String(r.template_id),
    name: String(r.name ?? ""),
    language: String(r.language ?? ""),
    category: String(r.category ?? ""),
    messages: Number(r.messages ?? 0),
    sent: Number(r.sent ?? 0),
    delivered: Number(r.delivered ?? 0),
    read_count: Number(r.read_count ?? 0),
    replied: Number(r.replied ?? 0),
    clicked: Number(r.clicked ?? 0),
    failed: Number(r.failed ?? 0),
    pending: Number(r.pending ?? 0),
    retries: Number(r.retries ?? 0),
    from_campaigns: Number(r.from_campaigns ?? 0),
  }));
}

/** Fixed caveats shown with every template performance view. */
export const TEMPLATE_PERFORMANCE_NOTES = [
  "Counted from Pulse's own messages and WhatsApp's delivery receipts. Meta's template analytics are not read.",
  "Replied means the patient wrote in the same conversation within 24 hours. Clicks are quick-reply button taps; WhatsApp does not report link-button clicks.",
  "A retried message counts as a separate message. Campaign messages are included.",
] as const;
