/** Funnel numbers, percentages and the CSV report. Pure; unit-tested. */
import { skipReasonLabel } from "@/lib/campaigns/constants";
import { toCsv } from "@/lib/csv";

export type Funnel = {
  total: number;
  eligible: number;
  pending: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
};

export const EMPTY_FUNNEL: Funnel = {
  total: 0,
  eligible: 0,
  pending: 0,
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  skipped: 0,
};

export function parseFunnel(raw: unknown): Funnel {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...EMPTY_FUNNEL };
  for (const k of Object.keys(out) as Array<keyof Funnel>) {
    const v = Number(o[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

/** Share of `part` in `whole`, one decimal; 0 when there is nothing to divide by. */
export function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Everything that can still change: pending or in the outbound queue. */
export function unresolved(f: Funnel): number {
  return f.pending + f.queued;
}

export type FunnelStage = { key: string; label: string; count: number; pct: number };

/** Total / Sent / Delivered / Read / Replied / Failed as % of the eligible audience (skipped excluded). */
export function funnelStages(f: Funnel): FunnelStage[] {
  const base = f.eligible;
  return [
    { key: "total", label: "Total", count: f.eligible, pct: base ? 100 : 0 },
    { key: "sent", label: "Sent", count: f.sent, pct: pct(f.sent, base) },
    { key: "delivered", label: "Delivered", count: f.delivered, pct: pct(f.delivered, base) },
    { key: "read", label: "Read", count: f.read, pct: pct(f.read, base) },
    { key: "replied", label: "Replied", count: f.replied, pct: pct(f.replied, base) },
    { key: "failed", label: "Failed", count: f.failed, pct: pct(f.failed, base) },
  ];
}

export type ReportRow = {
  name: string;
  phone: string | null;
  status: string;
  skip_reason: string | null;
  round: number;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  error_code: number | null;
  error_message: string | null;
};

export const REPORT_HEADERS = [
  "Name",
  "Phone",
  "Status",
  "Skip reason",
  "Round",
  "Sent at",
  "Delivered at",
  "Read at",
  "Replied at",
  "Error code",
  "Error",
];

/** CSV for "Download report" (formula-injection safe via csvEscape). */
export function reportCsv(rows: ReportRow[]): string {
  return toCsv(
    REPORT_HEADERS,
    rows.map((r) => [
      r.name,
      r.phone ?? "",
      r.status,
      skipReasonLabel(r.skip_reason),
      r.round,
      r.sent_at ?? "",
      r.delivered_at ?? "",
      r.read_at ?? "",
      r.replied_at ?? "",
      r.error_code ?? "",
      r.error_message ?? "",
    ]),
  );
}
