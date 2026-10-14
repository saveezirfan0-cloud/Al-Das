"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReportEmailKind } from "@/lib/finance/report-emails";

import { saveReportSchedule } from "./actions";

export type MemberOption = {
  id: string;
  name: string;
  /** Masked (ab***@domain): enough to recognise, never the whole address. */
  email: string | null;
  /** Holds the report's own permission now. */
  eligible: boolean;
};

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

/** One schedule: on/off, local time, day of the month (summary), and recipients picked from the members list. */
export function ScheduleForm({
  kind,
  value,
  members,
  timezone,
  nextSendText,
}: {
  kind: ReportEmailKind;
  value: { enabled: boolean; sendTime: string; dayOfMonth: number | null; recipientIds: string[] };
  members: MemberOption[];
  timezone: string;
  nextSendText: string | null;
}) {
  const [enabled, setEnabled] = React.useState(value.enabled);
  const [sendTime, setSendTime] = React.useState(value.sendTime);
  const [day, setDay] = React.useState(value.dayOfMonth ?? 3);
  const [chosen, setChosen] = React.useState<Set<string>>(() => new Set(value.recipientIds));
  const [pending, start] = React.useTransition();
  const id = `report-${kind}`;
  const toggle = (uid: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(uid);
      else next.delete(uid);
      return next;
    });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await saveReportSchedule({
            kind,
            enabled,
            sendTime,
            dayOfMonth: kind === "monthly_summary" ? day : null,
            recipientIds: [...chosen],
          });
          if (res.ok) toast.success(res.message ?? "Saved");
          else toast.error(res.error);
        });
      }}
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Send this report by e-mail
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Time" hint={`Local time (${timezone}).`}>
          <Input
            type="time"
            step={60}
            value={sendTime}
            onChange={(e) => setSendTime(e.target.value.slice(0, 5))}
            required
          />
        </Field>
        {kind === "monthly_summary" && (
          <Field label="Day of the month" hint="1 to 28, so every month has it.">
            <select
              className={selectClass}
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-who-hint`}>
        <legend className="text-sm font-medium">Who receives it</legend>
        <p id={`${id}-who-hint`} className="text-muted-foreground text-xs">
          Members who can see this report in Pulse. Addresses come from each person&apos;s own
          profile; they cannot be typed here.
        </p>
        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nobody in this workspace can see this report yet. Give the permission under Settings,
            Roles first.
          </p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {members.map((m) => (
              <li key={m.id}>
                <label className="hover:bg-muted flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={chosen.has(m.id)}
                    onChange={(e) => toggle(m.id, e.target.checked)}
                  />
                  <span className="font-medium">{m.name}</span>
                  {m.email ? (
                    <span className="text-muted-foreground truncate text-xs">{m.email}</span>
                  ) : (
                    <Badge variant="warning">no e-mail</Badge>
                  )}
                  {!m.eligible && <Badge variant="warning">can no longer see it</Badge>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <p className="text-muted-foreground text-xs" aria-live="polite">
        {enabled
          ? nextSendText
            ? `Next send: ${nextSendText} (after you save).`
            : "Choose a time to see the next send."
          : "Switched off: nothing is sent."}{" "}
        {chosen.size} {chosen.size === 1 ? "person" : "people"} chosen.
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" aria-hidden />} Save
        </Button>
      </div>
    </form>
  );
}
