"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { listContactAppointments } from "@/app/(app)/appointments/actions";
import type { ApptRow } from "@/app/(app)/appointments/types";
import { STATUS_STYLES } from "@/app/(app)/appointments/format";
import { STATUS_LABELS } from "@/lib/appointments/status";
import { cn } from "@/lib/utils";

/** Contact drawer → Appointments tab: portal and Unite appointments with links into the diary. */
export function ContactAppointments({ contactId }: { contactId: string }) {
  const [data, setData] = useState<{ rows: ApptRow[]; timezone: string; canBook: boolean } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void listContactAppointments(contactId).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) setData(r.data);
      else if (!r.ok) setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [contactId]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!data) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
      timeZone: data.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="flex flex-col gap-3">
      {data.canBook && (
        <Link
          href={`/appointments?new=${contactId}`}
          className="text-primary self-start text-sm hover:underline"
        >
          Book an appointment
        </Link>
      )}
      {data.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No appointments yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {data.rows.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <span className="font-medium">#{a.number}</span> · {fmt(a.starts_at)}
                <span className="text-muted-foreground block text-xs capitalize">{a.source}</span>
              </span>
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-xs",
                  STATUS_STYLES[a.status].replace("line-through", ""),
                )}
              >
                {STATUS_LABELS[a.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
