"use client";

import * as React from "react";
import { History, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { describeOp, type HistoryEntry } from "@/lib/security/history";

import { getRecordHistory } from "./actions";

/**
 * The shared History tab: field-level changes to one record, from the record_history table.
 * Used in the appointment, enquiry, task, template, flow and portal-record drawers.
 */
export function RecordHistory({ table, recordId }: { table: string; recordId: string }) {
  const [entries, setEntries] = React.useState<HistoryEntry[] | null>(null);
  const [people, setPeople] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setEntries(null);
    setError(null);
    void getRecordHistory({ table, recordId }).then((res) => {
      if (!live) return;
      if (res.ok) {
        setEntries(res.entries);
        setPeople(res.people);
      } else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [table, recordId]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!entries)
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading history…
      </div>
    );
  if (entries.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No changes recorded yet. Changes made from now on appear here.
      </p>
    );

  return (
    <ol className="flex flex-col gap-3">
      {entries.map((e) => (
        <li key={e.id} className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                e.op === "delete" ? "destructive" : e.op === "insert" ? "success" : "secondary"
              }
            >
              {describeOp(e.op)}
            </Badge>
            <span className="font-medium">
              {e.actorId ? (people[e.actorId] ?? "Former member") : "System"}
            </span>
            <time className="text-muted-foreground text-xs" dateTime={e.at}>
              {new Date(e.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </div>
          {e.changes.length > 0 && (
            <ul className="mt-2 grid gap-1">
              {e.changes.map((c) => (
                <li key={c.field} className="grid grid-cols-[8rem_1fr] gap-2 text-xs">
                  <span className="text-muted-foreground">{c.label}</span>
                  <span className="break-words">
                    <span className="text-muted-foreground line-through decoration-1">
                      {c.from}
                    </span>
                    {" → "}
                    <span className="font-medium">{c.to}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A "History" button that opens the shared panel in a side sheet (templates, flows). */
export function RecordHistoryButton({
  table,
  recordId,
  label = "History",
}: {
  table: string;
  recordId: string;
  label?: string;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <History /> {label}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>History</SheetTitle>
          <SheetDescription>Who changed which field, and when.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <RecordHistory table={table} recordId={recordId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Inline, collapsed-by-default section for form-style drawers (tasks, appointments). */
export function RecordHistorySection({ table, recordId }: { table: string; recordId: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="grid gap-2 border-t pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <History /> {open ? "Hide history" : "Show history"}
      </Button>
      {open && <RecordHistory table={table} recordId={recordId} />}
    </div>
  );
}
