"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNumber, formatPercent } from "@/lib/reports/format";
import { templateRates, type TemplatePerformanceRow } from "@/lib/templates/performance";

import { getTemplatePerformance } from "./actions";

function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function PerformanceDialog({
  open,
  onOpenChange,
  templateId,
  name,
  today,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templateId: string;
  name: string;
  /** Today in the workspace timezone (YYYY-MM-DD). */
  today: string;
}) {
  const [from, setFrom] = useState(shiftDay(today, -29));
  const [to, setTo] = useState(today);
  const [row, setRow] = useState<TemplatePerformanceRow | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, startTransition] = useTransition();

  function load(f = from, t = to) {
    setError(null);
    startTransition(async () => {
      const r = await getTemplatePerformance({ template_id: templateId, from: f, to: t });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setRow(r.data.row);
      setNotes(r.data.notes);
      setLoaded(true);
    });
  }

  useEffect(() => {
    if (open && !loaded) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first open only
  }, [open]);

  const rates = row ? templateRates(row) : null;
  const tiles: Array<{ label: string; value: string; hint?: string }> = row
    ? [
        {
          label: "Messages",
          value: formatNumber(row.messages),
          hint: row.retries ? `${row.retries} retries` : undefined,
        },
        { label: "Sent", value: formatNumber(row.sent) },
        {
          label: "Delivered",
          value: formatNumber(row.delivered),
          hint: formatPercent(rates?.delivered),
        },
        { label: "Read", value: formatNumber(row.read_count), hint: formatPercent(rates?.read) },
        { label: "Replied", value: formatNumber(row.replied), hint: formatPercent(rates?.replied) },
        {
          label: "Button clicks",
          value: formatNumber(row.clicked),
          hint: formatPercent(rates?.clicked),
        },
        { label: "Failed", value: formatNumber(row.failed), hint: formatPercent(rates?.failed) },
        { label: "Still sending", value: formatNumber(row.pending) },
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Performance · {name}</DialogTitle>
          <DialogDescription>
            Messages sent with this template in the period, and what happened to them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="perf-from">From</Label>
            <Input
              id="perf-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="perf-to">To</Label>
            <Input
              id="perf-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Show
          </Button>
        </form>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {loaded && !row && !error && (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            No messages with this template in the period.
          </p>
        )}
        {row && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-lg border p-3">
                <div className="text-muted-foreground text-xs">{t.label}</div>
                <div className="text-lg font-semibold tabular-nums">{t.value}</div>
                {t.hint && <div className="text-muted-foreground text-xs">{t.hint}</div>}
              </div>
            ))}
          </div>
        )}
        {notes.length > 0 && (
          <ul className="text-muted-foreground list-disc pl-5 text-xs">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          All templates side by side:{" "}
          <Link href="/reports/template-performance" className="underline">
            Reports, Template performance
          </Link>
          .
        </p>
      </DialogContent>
    </Dialog>
  );
}
