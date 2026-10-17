"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveLifecycleSettingsAction } from "./actions";

export function LifecycleForm({
  initial,
}: {
  initial: { newPatientDays: number; activeMonths: number };
}) {
  const [days, setDays] = React.useState(String(initial.newPatientDays));
  const [months, setMonths] = React.useState(String(initial.activeMonths));
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveLifecycleSettingsAction({
        newPatientDays: Number(days),
        activeMonths: Number(months),
      });
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="lc-days">New patient: first visit within (days)</Label>
        <Input
          id="lc-days"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="w-32"
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="lc-months">Active: last visit within (months)</Label>
        <Input
          id="lc-months"
          type="number"
          inputMode="numeric"
          min={1}
          max={60}
          value={months}
          onChange={(e) => setMonths(e.target.value)}
          className="w-32"
          required
        />
        <p className="text-muted-foreground text-xs">
          A patient whose last visit is older than this is lapsed. A contact with no Unite number
          and no visit is a lead; a registered patient with no usable visit date is shown as not
          enough visit data.
        </p>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save
        </Button>
      </div>
    </form>
  );
}
