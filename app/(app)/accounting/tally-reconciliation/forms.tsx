"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { lockImportedPeriods, reconcileWithTally } from "./actions";

export function ReconcileForm({
  imports,
  today,
  entities = [],
}: {
  imports: Array<{ id: string; label: string; last_date: string | null }>;
  today: string;
  /** Shown when there is more than one: which entity's books to compare when no import is chosen. */
  entities?: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [importId, setImportId] = useState(imports[0]?.id ?? "");
  const [asAt, setAsAt] = useState(imports[0]?.last_date ?? today);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const res = await reconcileWithTally(fd);
          if (res.ok) {
            (res.data?.reconciled ? toast.success : toast.warning)(res.message ?? "Done");
            router.refresh();
          } else toast.error(res.error);
        });
      }}
    >
      <Field label="Import">
        <select
          name="import_id"
          className={selectClass}
          value={importId}
          onChange={(e) => {
            setImportId(e.target.value);
            const hit = imports.find((i) => i.id === e.target.value);
            if (hit?.last_date) setAsAt(hit.last_date);
          }}
        >
          {imports.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
          <option value="">No import (compare the books only)</option>
        </select>
      </Field>
      {entities.length > 1 && !importId && (
        <Field label="Entity">
          <select name="entity_id" className={selectClass} defaultValue={entities[0].id}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="As at">
        <Input
          type="date"
          name="as_at"
          value={asAt}
          onChange={(e) => setAsAt(e.target.value)}
          className="w-44"
          required
        />
      </Field>
      <Field label="Tally trial balance (.xlsx or .csv)">
        <Input type="file" name="file" accept=".xlsx,.csv" required />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />} Compare
      </Button>
    </form>
  );
}

export function LockImportButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="Lock the imported months"
      title="Lock the imported months"
      description="Closes and locks every month this import covers, from the opening date to the last voucher. Nothing can ever be posted into a locked month again, by anyone (the year's adjustment period stays open for the year-end close)."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={(v) => lockImportedPeriods({ id, confirm: v.confirm ?? "" })}
          submitLabel="Lock for good"
          variant="destructive"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Type LOCK to confirm">
            <Input name="confirm" autoComplete="off" required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}
