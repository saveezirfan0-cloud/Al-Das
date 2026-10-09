"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { listContactEnquiries, type ContactEnquiry } from "@/app/(app)/enquiries/actions";
import { StatusBadge } from "@/app/(app)/enquiries/enquiries-grid";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/contacts/format";

/** Contacts drawer → Enquiries tab: this contact's enquiries, linking into the Enquiries screen. */
export function ContactEnquiries({
  contactId,
  timezone,
  canView,
  canCreate,
}: {
  contactId: string;
  timezone: string;
  canView: boolean;
  canCreate: boolean;
}) {
  const [rows, setRows] = useState<ContactEnquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    setRows(null);
    listContactEnquiries(contactId).then((r) => {
      if (!alive) return;
      if (r.ok) setRows(r.data.rows);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [contactId, canView]);

  if (!canView)
    return <p className="text-muted-foreground text-sm">You do not have access to enquiries.</p>;
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!rows) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  return (
    <div className="flex flex-col gap-3">
      {canCreate && (
        <Button variant="outline" size="sm" className="w-fit" asChild>
          <Link href={`/enquiries?new=1&contact=${contactId}`}>
            <Plus /> New enquiry
          </Link>
        </Button>
      )}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No enquiries for this contact yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((e) => (
            <li key={e.id}>
              <Link
                href={`/enquiries?pipeline=all&scope=all&mode=table&enquiry=${e.id}`}
                className="hover:bg-accent flex flex-col gap-0.5 rounded px-2 py-2"
              >
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">#{e.number}</span>
                  <span className="font-medium">{e.title}</span>
                  <StatusBadge status={e.status} />
                  <span className="text-muted-foreground ml-auto text-xs">
                    {formatDate(e.created_at, timezone)}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {e.pipeline}
                  {e.stage ? ` · ${e.stage}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
