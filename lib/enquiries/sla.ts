/** SLA maths for open enquiries. Pure. */
import type { EnquiryStatus } from "@/lib/enquiries/status";

export type SlaSubject = {
  status: EnquiryStatus | string;
  stage_entered_at: string;
  sla_alerted_at: string | null;
};

const HOUR_MS = 3_600_000;

/** When the SLA runs out for the current stage visit (null when there is no SLA or it is closed). */
export function slaDueAt(
  e: Pick<SlaSubject, "status" | "stage_entered_at">,
  slaHours: number | null,
): Date | null {
  if (!slaHours || e.status !== "open") return null;
  const entered = new Date(e.stage_entered_at).getTime();
  if (Number.isNaN(entered)) return null;
  return new Date(entered + slaHours * HOUR_MS);
}

export function isSlaBreached(
  e: Pick<SlaSubject, "status" | "stage_entered_at">,
  slaHours: number | null,
  now: Date = new Date(),
): boolean {
  const due = slaDueAt(e, slaHours);
  return due !== null && due.getTime() <= now.getTime();
}

/** Breached and not yet alerted for this stage visit (alerts are cleared when the stage changes). */
export function needsSlaAlert(
  e: SlaSubject,
  slaHours: number | null,
  now: Date = new Date(),
): boolean {
  if (
    e.sla_alerted_at &&
    new Date(e.sla_alerted_at).getTime() >= new Date(e.stage_entered_at).getTime()
  )
    return false;
  return isSlaBreached(e, slaHours, now);
}

/** "2 h 15 min" style remaining / overdue text for cards. */
export function formatSlaRemaining(due: Date, now: Date = new Date()): string {
  const diff = due.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const h = Math.floor(abs / HOUR_MS);
  const m = Math.floor((abs % HOUR_MS) / 60_000);
  const text = h > 0 ? `${h} h${m ? ` ${m} min` : ""}` : `${Math.max(m, 1)} min`;
  return diff >= 0 ? `${text} left` : `${text} overdue`;
}
