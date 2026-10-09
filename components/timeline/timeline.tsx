"use client";

import { formatDateTime } from "@/lib/contacts/format";

export type TimelineItem = {
  id: string;
  type: string;
  actor_type: string;
  actor_name: string | null;
  payload: unknown;
  at: string;
};

const EVENT_LABELS: Record<string, string> = {
  "contact.created": "Contact created",
  "contact.updated": "Details updated",
  "contact.merged": "Merged a duplicate into this contact",
  "import.created": "Created by import",
  "import.updated": "Updated by import",
  "tags.changed": "Tags changed",
  "phone.added": "Alternate phone added",
  "phone.removed": "Alternate phone removed",
  "phone.primary_changed": "Primary phone changed",
  note: "Note",
  "enquiry.created": "Enquiry created",
  "enquiry.updated": "Enquiry updated",
  "enquiry.stage_changed": "Stage changed",
  "enquiry.status_changed": "Status changed",
  "enquiry.pipeline_changed": "Moved to another pipeline",
  "enquiry.sla_breached": "SLA breached",
};

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function TimelinePayload({ type, payload }: { type: string; payload: unknown }) {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (type === "note" && typeof p.text === "string")
    return <p className="mt-1 whitespace-pre-wrap">{p.text}</p>;
  if (type === "contact.updated" && p.changes && typeof p.changes === "object") {
    const changes = p.changes as Record<string, { from: unknown; to: unknown }>;
    return (
      <ul className="text-muted-foreground mt-1 text-xs">
        {Object.entries(changes).map(([k, v]) => (
          <li key={k}>
            {k.replace(/_/g, " ")}: {fmt(v.from)} → {fmt(v.to)}
          </li>
        ))}
      </ul>
    );
  }
  if (type === "enquiry.stage_changed")
    return (
      <p className="text-muted-foreground mt-1 text-xs">
        {fmt(str(p.from_name))} → {fmt(str(p.to_name))}
      </p>
    );
  if (type === "enquiry.status_changed")
    return (
      <p className="text-muted-foreground mt-1 text-xs">
        {fmt(str(p.from))} → {fmt(str(p.to))}
        {str(p.reason) ? ` · ${str(p.reason)}` : ""}
      </p>
    );
  if (type === "enquiry.pipeline_changed")
    return (
      <p className="text-muted-foreground mt-1 text-xs">
        {fmt(str(p.to_name))} · {fmt(str(p.to_stage_name))}
      </p>
    );
  if (type === "enquiry.updated" && Array.isArray(p.fields) && p.fields.length)
    return (
      <p className="text-muted-foreground mt-1 text-xs">
        {(p.fields as unknown[])
          .map((f) => String(f).replace(/_id$/, "").replace(/_/g, " "))
          .join(", ")}
        {p.custom_changed ? ", custom fields" : ""}
      </p>
    );
  return null;
}

/** Newest-first activity list shared by the contact and enquiry drawers. */
export function Timeline({
  events,
  timezone,
  emptyText = "No activity yet.",
}: {
  events: TimelineItem[];
  timezone: string;
  emptyText?: string;
}) {
  return (
    <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {events.length === 0 && <li className="text-muted-foreground text-sm">{emptyText}</li>}
      {events.map((e) => (
        <li key={e.id} className="flex gap-3 text-sm">
          <span className="bg-border mt-2 size-2 shrink-0 rounded-full" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
              <span className="text-muted-foreground text-xs">
                {e.actor_name ??
                  (e.actor_type === "system"
                    ? "System"
                    : e.actor_type === "job"
                      ? "Automation"
                      : "")}{" "}
                · {formatDateTime(e.at, timezone)}
              </span>
            </div>
            <TimelinePayload type={e.type} payload={e.payload} />
          </div>
        </li>
      ))}
    </ol>
  );
}
