"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { EnquiryRow } from "@/lib/enquiries/types";

import { enquiriesForContactAction } from "./actions";
import { StatusBadge } from "./badges";
import { ago } from "./format";

/** A patient's enquiries (contact drawer, inbox sidebar) with links into the board and a "New enquiry" shortcut. */
export function ContactEnquiries({ contactId }: { contactId: string }) {
  const [data, setData] = useState<{ rows: EnquiryRow[]; canCreate: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void enquiriesForContactAction(contactId).then((r) => {
      if (!alive) return;
      if (r.ok) setData({ rows: r.rows, canCreate: r.canCreate });
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [contactId]);

  if (error) return <p className="text-muted-foreground text-sm">{error}</p>;
  if (!data)
    return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />;

  return (
    <div className="flex flex-col gap-2">
      {data.rows.length === 0 && (
        <p className="text-muted-foreground text-sm">No enquiries for this patient yet.</p>
      )}
      <ul className="flex flex-col gap-2">
        {data.rows.map((e) => (
          <li key={e.id}>
            <Link
              href={`/enquiries?pipeline=${e.pipeline_id}&enquiry=${e.id}`}
              className="hover:bg-accent flex flex-col gap-1 rounded-md border p-2.5 text-sm"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  #{e.number} {e.title}
                </span>
                <StatusBadge status={e.status} />
              </span>
              <span className="text-muted-foreground text-xs">
                {e.pipeline_name} · {e.stage_name}
                {e.assignee_name ? ` · ${e.assignee_name}` : ""} · {ago(e.created_at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {data.canCreate && (
        <Button size="sm" variant="outline" className="self-start" asChild>
          <Link href={`/enquiries?new=${contactId}`}>
            <Plus /> New enquiry
          </Link>
        </Button>
      )}
    </div>
  );
}
