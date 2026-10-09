"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveSlaMinutes } from "./actions";

export function SlaForm({ minutes }: { minutes: number }) {
  const [value, setValue] = useState(String(minutes));
  const [pending, start] = useTransition();
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveSlaMinutes(Number(value));
          if (r.ok) toast.success(r.message);
          else toast.error(r.error);
        });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="sla-minutes">Reply SLA (minutes)</Label>
        <Input id="sla-minutes" type="number" min={1} max={1440} className="w-28" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Save
      </Button>
    </form>
  );
}
