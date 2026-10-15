"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { saveFirstResponseTargets } from "./work-actions";

/** Administrators: when "waiting" turns amber and red on the list (minutes without a reply). */
export function SlaSettings({ amber, red }: { amber: number; red: number }) {
  const [a, setA] = useState(String(amber));
  const [r, setR] = useState(String(red));
  const [pending, startTransition] = useTransition();
  return (
    <fieldset className="grid gap-1.5 border-t pt-3 text-xs">
      <legend className="sr-only">Response-time colours</legend>
      <span className="font-medium">Waiting colours (minutes without a reply)</span>
      <div className="flex items-end gap-2">
        <label className="grid flex-1 gap-1">
          Amber from
          <Input
            type="number"
            min={1}
            inputMode="numeric"
            className="h-8"
            value={a}
            onChange={(e) => setA(e.target.value)}
          />
        </label>
        <label className="grid flex-1 gap-1">
          Red from
          <Input
            type="number"
            min={2}
            inputMode="numeric"
            className="h-8"
            value={r}
            onChange={(e) => setR(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await saveFirstResponseTargets({ amber: Number(a), red: Number(r) });
              if (res.ok) toast.success(res.message ?? "Saved.");
              else toast.error(res.error);
            })
          }
        >
          Save
        </Button>
      </div>
    </fieldset>
  );
}
