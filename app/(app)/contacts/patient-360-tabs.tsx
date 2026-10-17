"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  ClipboardList,
  History,
  Loader2,
  MessageSquare,
  NotebookPen,
  Receipt,
  Target,
} from "lucide-react";

import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/contacts/format";
import type { HistoryItem, HistoryKind } from "@/lib/contacts/history";
import { cn } from "@/lib/utils";

import {
  contactHistory,
  listContactInvoices,
  listContactTasks,
  type ContactInvoice,
  type ContactTask,
} from "./patient-360-actions";

/** Patient 360 tabs (Phase F): Tasks, Invoices and History for one patient. */

function useLoad<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void load().then((r) => {
      if (!alive) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [load]);
  return { data, error };
}

export function ContactTasks({
  contactId,
  timezone,
  users,
}: {
  contactId: string;
  timezone: string;
  users: Array<{ id: string; label: string }>;
}) {
  const load = useCallback(() => listContactTasks(contactId), [contactId]);
  const { data, error } = useLoad(load);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!data) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  if (data.rows.length === 0)
    return (
      <EmptyState
        icon={ClipboardList}
        title="No tasks for this patient"
        description="Create one from a chat (Task button) or on the Tasks page with this patient linked."
      />
    );
  const name = new Map(users.map((u) => [u.id, u.label]));
  const now = Date.now();
  return (
    <ul className="divide-y text-sm">
      {data.rows.map((t: ContactTask) => {
        const overdue = !t.done && new Date(t.due_at).getTime() < now;
        return (
          <li key={t.id} className="flex items-start justify-between gap-3 py-2">
            <span className="min-w-0">
              <Link
                href={`/tasks?task=${t.id}`}
                className={cn(
                  "font-medium hover:underline",
                  t.done && "text-muted-foreground line-through",
                )}
              >
                {t.subject}
              </Link>
              <span className="text-muted-foreground block text-xs">
                Due {formatDateTime(t.due_at, timezone)}
                {overdue && <span className="text-destructive font-medium"> · overdue</span>}
                {t.assignee_id ? ` · ${name.get(t.assignee_id) ?? "Colleague"}` : " · Unassigned"}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <Badge
                variant={t.done ? "secondary" : t.status === "blocked" ? "warning" : "outline"}
              >
                {t.status_label}
              </Badge>
              {(t.priority === "high" || t.priority === "urgent") && (
                <span className="text-xs font-medium text-red-700 dark:text-red-300">
                  {t.priority_label}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const money = (n: number | null) =>
  n === null
    ? "–"
    : n.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ContactInvoices({ contactId }: { contactId: string }) {
  const load = useCallback(() => listContactInvoices(contactId), [contactId]);
  const { data, error } = useLoad(load);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!data) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  if (!data.linked)
    return (
      <EmptyState
        icon={Receipt}
        title="Not linked to Unite yet"
        description="Invoices are matched by the patient's Unite PIN. Add it in the details on the left (External ID)."
      />
    );
  if (data.rows.length === 0)
    return (
      <EmptyState
        icon={Receipt}
        title="No invoices for this PIN"
        description="Invoices captured from Unite appear here."
      />
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="text-muted-foreground pb-2 text-left text-xs">
          Amounts in AED. Open an invoice for the payer and balance.
        </caption>
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th className="py-1.5 font-medium">Invoice</th>
            <th className="py-1.5 font-medium">Date</th>
            <th className="py-1.5 text-right font-medium">Net</th>
            <th className="py-1.5 text-right font-medium">Claimed</th>
            <th className="py-1.5 text-right font-medium">Paid</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.rows.map((r: ContactInvoice) => (
            <tr key={r.id} className={cn(r.void && "text-muted-foreground line-through")}>
              <td className="py-1.5">
                <Link href={`/finance/invoices/${r.id}`} className="hover:underline">
                  {r.number ?? "Invoice"}
                </Link>
                {r.noAppointment && (
                  <span className="text-muted-foreground ml-2 text-xs">
                    appointment not in Pulse
                  </span>
                )}
              </td>
              <td className="py-1.5 tabular-nums">{r.date ?? "–"}</td>
              <td className="py-1.5 text-right tabular-nums">{money(r.net)}</td>
              <td className="py-1.5 text-right tabular-nums">{money(r.claimed)}</td>
              <td className="py-1.5 text-right tabular-nums">{money(r.paid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length >= 50 && (
        <p className="text-muted-foreground py-2 text-xs">
          Showing the latest 50. Finance, Invoices has the rest.
        </p>
      )}
    </div>
  );
}

const KIND_ICON: Record<HistoryKind, typeof History> = {
  message: MessageSquare,
  appointment: CalendarDays,
  enquiry: Target,
  task: ClipboardList,
  note: NotebookPen,
};

export function ContactHistory({ contactId, timezone }: { contactId: string; timezone: string }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (from: string | null) => {
      setLoading(true);
      const r = await contactHistory(contactId, from);
      setLoading(false);
      if (!r.ok) return setError(r.error);
      setItems((prev) => (from ? [...prev, ...r.data.items] : r.data.items));
      setCursor(r.data.nextCursor);
    },
    [contactId],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setError(null);
    void loadPage(null);
  }, [loadPage]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!loading && items.length === 0)
    return (
      <EmptyState
        icon={History}
        title="Nothing yet"
        description="Messages, appointments, enquiries, tasks and notes for this patient appear here, newest first."
      />
    );
  return (
    <div className="flex flex-col gap-2">
      <ol className="relative flex flex-col gap-3 border-l pl-4">
        {items.map((it) => {
          const Icon = KIND_ICON[it.kind];
          return (
            <li key={`${it.kind}:${it.id}`} className="relative text-sm">
              <span className="bg-background absolute top-0.5 -left-[1.6rem] flex size-5 items-center justify-center rounded-full border">
                <Icon className="text-muted-foreground size-3" aria-hidden />
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2">
                {it.href ? (
                  <Link href={it.href} className="font-medium hover:underline">
                    {it.title}
                  </Link>
                ) : (
                  <span className="font-medium">{it.title}</span>
                )}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatDateTime(it.at, timezone)}
                </span>
              </div>
              {it.detail && (
                <p className="text-muted-foreground line-clamp-2 text-xs whitespace-pre-line">
                  {it.detail}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {loading && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
      {!loading && cursor && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void loadPage(cursor)}
        >
          Show older
        </Button>
      )}
    </div>
  );
}
