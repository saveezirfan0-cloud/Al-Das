import { STATUS_LABELS, type AppointmentStatus } from "@/lib/appointments/status";

/**
 * Status history of an appointment (Patient 360, Appointments tab), read from record_history (Phase 15), which already
 * records every change of `appointments.status` and `appointments.external_status` with who made it (no actor = the
 * Unite sync or another automatic job). Pure: rows in, display changes out. Ids, status words and times only.
 *
 * History starts when the trigger started recording: appointments synced from Unite will show their changes from the
 * first sync onward, and the first sync of an appointment (the insert) records no change.
 */

export type HistoryRow = {
  id: number | string;
  record_id: string;
  at: string;
  actor_id: string | null;
  changes: unknown;
};

export type StatusChange = {
  id: string;
  appointmentId: string;
  at: string;
  kind: "status" | "unite_code";
  from: string | null;
  to: string | null;
  /** A person changed it (true) or an automatic job did (false). */
  byStaff: boolean;
};

function isStatus(v: unknown): v is AppointmentStatus {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STATUS_LABELS, v);
}

function word(v: unknown, kind: StatusChange["kind"]): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return null;
  return kind === "status" && isStatus(v) ? STATUS_LABELS[v] : v;
}

function pair(changes: unknown, key: string): { from: unknown; to: unknown } | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const c = (changes as Record<string, unknown>)[key];
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  return "from" in o || "to" in o ? { from: o.from, to: o.to } : null;
}

/** Status and Unite-code changes, newest first. A row that changed both gives two entries. */
export function statusChangesFrom(rows: readonly HistoryRow[]): StatusChange[] {
  const out: StatusChange[] = [];
  for (const r of rows) {
    for (const [key, kind] of [
      ["status", "status"],
      ["external_status", "unite_code"],
    ] as const) {
      const p = pair(r.changes, key);
      if (!p) continue;
      out.push({
        id: `${r.id}:${kind}`,
        appointmentId: r.record_id,
        at: r.at,
        kind,
        from: word(p.from, kind),
        to: word(p.to, kind),
        byStaff: r.actor_id !== null,
      });
    }
  }
  // Stable: two changes in the same row keep their order (status first).
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** "Awaiting → Confirmed", "Unite code ACF set", "Unite code YTC → ACF". */
export function describeChange(c: Pick<StatusChange, "kind" | "from" | "to">): string {
  const subject = c.kind === "unite_code" ? "Unite code" : "Status";
  if (c.from && c.to) return `${subject}: ${c.from} → ${c.to}`;
  if (c.to) return `${subject} set to ${c.to}`;
  if (c.from) return `${subject} ${c.from} cleared`;
  return `${subject} changed`;
}
