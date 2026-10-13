"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CHOOSABLE_CLASSES,
  CLASS_LABEL,
  type ChoosableClass,
} from "@/lib/clinical/medication-class";
import type { MedClass } from "@/lib/clinical/evaluate";

import { classifyMedication } from "./actions";

export type UnclassifiedRow = {
  code: string;
  name: string | null;
  prescriptions: number;
  firstSeen: string | null;
  lastSeen: string | null;
  medicineType: string | null;
  suggestion: MedClass;
};

function RowForm({ item }: { item: UnclassifiedRow }) {
  const [pending, startTransition] = React.useTransition();
  const [drugClass, setDrugClass] = React.useState<ChoosableClass | "">("");
  const [probiotics, setProbiotics] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  const id = `classify-${item.code}`;

  function save() {
    if (!drugClass || !confirmed) return;
    startTransition(async () => {
      const res = await classifyMedication({
        code: item.code,
        drugClass,
        requiresProbiotics: probiotics,
        confirmed: true,
      });
      if (res.ok) toast.success(res.message ?? "Saved.");
      else toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${id}-class`} className="sr-only">
        Class for {item.code}
      </label>
      <select
        id={`${id}-class`}
        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        value={drugClass}
        onChange={(e) => setDrugClass(e.target.value as ChoosableClass | "")}
      >
        <option value="">Choose a class…</option>
        {CHOOSABLE_CLASSES.map((c) => (
          <option key={c} value={c}>
            {CLASS_LABEL[c]}
          </option>
        ))}
      </select>
      {drugClass === "antibiotic" && (
        <div className="flex items-center gap-1.5">
          <Checkbox
            id={`${id}-pro`}
            checked={probiotics}
            onCheckedChange={(v) => setProbiotics(v === true)}
          />
          <Label htmlFor={`${id}-pro`} className="text-xs">
            Probiotics afterwards by default
          </Label>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Checkbox
          id={`${id}-ok`}
          checked={confirmed}
          onCheckedChange={(v) => setConfirmed(v === true)}
        />
        <Label htmlFor={`${id}-ok`} className="text-xs">
          I checked this drug
        </Label>
      </div>
      <Button size="sm" onClick={save} disabled={pending || !drugClass || !confirmed}>
        {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        Save
      </Button>
    </div>
  );
}

export function ClassifyList({ items, canWrite }: { items: UnclassifiedRow[]; canWrite: boolean }) {
  if (items.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        Every medication code on a prescription has a class. Nothing to review.
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Unite code</TableHead>
            <TableHead>Medication</TableHead>
            <TableHead className="text-right">Prescriptions</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Suggestion</TableHead>
            {canWrite && <TableHead>Classify</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((r) => (
            <TableRow key={r.code}>
              <TableCell className="font-mono text-xs">{r.code}</TableCell>
              <TableCell>
                <div>{r.name ?? "—"}</div>
                {r.medicineType && (
                  <div className="text-muted-foreground text-xs">Unite type: {r.medicineType}</div>
                )}
              </TableCell>
              <TableCell className="text-right">{r.prescriptions}</TableCell>
              <TableCell className="whitespace-nowrap">{r.lastSeen ?? "—"}</TableCell>
              <TableCell>
                <Badge variant="outline">{CLASS_LABEL[r.suggestion]}</Badge>
              </TableCell>
              {canWrite && (
                <TableCell>
                  <RowForm item={r} />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
