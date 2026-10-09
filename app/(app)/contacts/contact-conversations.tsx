"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { listContactConversations } from "@/app/(app)/inbox/actions";

type Row = {
  id: string;
  status: string;
  channel: string;
  last_message_at: string | null;
  preview: string | null;
  unread: number;
};

/** Contacts drawer → Inbox tab: this contact's WhatsApp conversations with links into the inbox. */
export function ContactConversations({ contactId }: { contactId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setRows(null);
    listContactConversations(contactId).then((r) => {
      if (!alive) return;
      if (r.ok) setRows(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [contactId]);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!rows) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  if (rows.length === 0)
    return <p className="text-muted-foreground text-sm">No WhatsApp conversations yet.</p>;
  return (
    <ul className="divide-y text-sm">
      {rows.map((c) => (
        <li key={c.id}>
          <Link
            href={`/inbox?c=${c.id}`}
            className="hover:bg-accent flex flex-col gap-0.5 rounded px-2 py-2"
          >
            <span className="flex items-center gap-2">
              <span className="font-medium">{c.channel}</span>
              <Badge
                variant={
                  c.status === "closed"
                    ? "outline"
                    : c.status === "waiting"
                      ? "warning"
                      : "secondary"
                }
              >
                {c.status}
              </Badge>
              {c.unread > 0 && <Badge>{c.unread} unread</Badge>}
              <span className="text-muted-foreground ml-auto text-xs">
                {c.last_message_at ? new Date(c.last_message_at).toLocaleString() : ""}
              </span>
            </span>
            {c.preview && (
              <span className="text-muted-foreground line-clamp-1 text-xs">{c.preview}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
