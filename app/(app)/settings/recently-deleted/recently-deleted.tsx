"use client";

import * as React from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ENTITY_RULES,
  MAX_RESTORE_WINDOW_DAYS,
  MIN_RESTORE_WINDOW_DAYS,
  type SoftDeleteEntity,
} from "@/lib/soft-delete/rules";

import { restoreDeletedItem, saveRestoreWindow } from "./actions";

type Row = {
  entity: SoftDeleteEntity;
  recordId: string;
  title: string;
  deletedBy: string | null;
  deletedAtLabel: string;
  daysLeft: number;
};

function daysLeftLabel(n: number): string {
  if (n <= 0) return "Removed tonight";
  return `${n} day${n === 1 ? "" : "s"} left`;
}

export function DeletedItemsTable({ rows }: { rows: Row[] }) {
  const [gone, setGone] = React.useState<Set<string>>(() => new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const visible = rows.filter((r) => !gone.has(`${r.entity}:${r.recordId}`));

  async function restore(r: Row) {
    const key = `${r.entity}:${r.recordId}`;
    setBusy(key);
    const res = await restoreDeletedItem(r.entity, r.recordId);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setGone((s) => new Set(s).add(key));
    toast.success(res.message);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deleted items</CardTitle>
        <CardDescription>
          Newest first. Restoring puts the record back where it was, with its links.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing has been deleted recently.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {visible.map((r) => {
              const key = `${r.entity}:${r.recordId}`;
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <Badge variant="outline">{ENTITY_RULES[r.entity].label}</Badge>
                      <span className="break-words">{r.title}</span>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Deleted {r.deletedAtLabel}
                      {r.deletedBy ? ` by ${r.deletedBy}` : ""} ·{" "}
                      <span className={r.daysLeft <= 3 ? "font-medium" : undefined}>
                        {daysLeftLabel(r.daysLeft)}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || r.daysLeft <= 0}
                    onClick={() => void restore(r)}
                    aria-label={`Restore ${ENTITY_RULES[r.entity].label.toLowerCase()} ${r.title}`}
                  >
                    {busy === key ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw className="size-4" aria-hidden />
                    )}
                    Restore
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RestoreWindowForm({ initial }: { initial: number }) {
  const [days, setDays] = React.useState<number>(initial);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveRestoreWindow(days);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Restore window</CardTitle>
        <CardDescription>
          How long deleted records can be restored. Shortening it removes older items at the next
          nightly run.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="restore-window-days">Days</Label>
            <Input
              id="restore-window-days"
              type="number"
              inputMode="numeric"
              className="w-28"
              min={MIN_RESTORE_WINDOW_DAYS}
              max={MAX_RESTORE_WINDOW_DAYS}
              step={1}
              value={Number.isFinite(days) ? days : ""}
              onChange={(e) =>
                setDays(e.target.value === "" ? Number.NaN : Number(e.target.value))
              }
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Save
          </Button>
          <p className="text-muted-foreground w-full text-xs">
            Between {MIN_RESTORE_WINDOW_DAYS} and {MAX_RESTORE_WINDOW_DAYS} days. The default is 30.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
