"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  CalendarClock,
  CalendarPlus,
  CalendarX2,
  Clock,
  Hourglass,
  Loader2,
  MapPin,
  Phone,
  UsersRound,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LATE_MINUTE_CHOICES } from "@/lib/front-desk/messages";
import { ageLabel, type CardFlag } from "@/lib/front-desk/patient-card";
import type { PatientCardData } from "@/lib/front-desk/server";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

import {
  cancelFromDesk,
  logCall,
  removeFromWaitlist,
  sendDeskMessageAction,
  unlinkDependant,
} from "./actions";
import { DependantDialog, RescheduleDialog, WaitlistDialog } from "./dialogs";
import type { DeskCan, DeskOptions } from "./types";

const FLAG_TONE: Record<CardFlag["tone"], string> = {
  info: "bg-muted text-foreground",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  alert: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

function when(iso: string, tz: string) {
  return formatInTimeZone(new Date(iso), tz, "EEE d MMM, h:mm a");
}

/**
 * The patient card: next appointment, last visit, open enquiry, flags, household, waiting list, and the
 * one-tap actions. Used beside a conversation (inbox) and under the search box on the Front desk.
 */
export function PatientCardView({
  card,
  options,
  can,
  onChanged,
  compact,
}: {
  card: PatientCardData;
  options: DeskOptions;
  can: DeskCan;
  /** Called after an action that changes what the card shows (the host reloads it). */
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [late, setLate] = useState<string>("15");
  const tz = options.timezone;
  const c = card.contact;
  const next = card.next_appointment;
  const age = ageLabel(c.dob, new Date(card.now));
  const callPhone = c.phone ?? card.household.guardian?.phone ?? null;

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast.success(r.message);
        onChanged?.();
      } else toast.error(r.error ?? "That did not work.");
    });
  }

  return (
    <section
      className={cn("flex flex-col gap-3 rounded-lg border p-3 text-sm", compact && "text-xs")}
      aria-label="Patient card"
    >
      <header>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base leading-tight font-semibold">{c.name}</h3>
          {age && <span className="text-muted-foreground text-xs">{age}</span>}
        </div>
        <p className="text-muted-foreground text-xs">
          {c.phone ? formatPhone(c.phone) : c.has_bsuid ? "WhatsApp username" : "No phone"}
          {c.language ? ` · ${c.language}` : ""}
        </p>
        {card.flags.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1" aria-label="Flags">
            {card.flags.map((f) => (
              <li
                key={f.key}
                className={cn("rounded px-1.5 py-0.5 text-[11px]", FLAG_TONE[f.tone])}
              >
                {f.label}
              </li>
            ))}
          </ul>
        )}
      </header>

      <dl className="grid gap-2">
        <div>
          <dt className="text-muted-foreground text-xs">Next appointment</dt>
          <dd>
            {next ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{when(next.starts_at, tz)}</span>
                {next.patient_name && <Badge variant="outline">{next.patient_name}</Badge>}
                <span className="text-muted-foreground">
                  {[next.specialist_name, next.service_name, next.location_name]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <Badge variant={next.status === "confirmed" ? "success" : "secondary"}>
                  {next.status === "confirmed" ? "Confirmed" : "Unconfirmed"}
                </Badge>
              </span>
            ) : (
              <span className="text-muted-foreground">None booked</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Last visit</dt>
          <dd>
            {card.last_visit ? (
              <>
                {when(card.last_visit.starts_at, tz)}
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  {[card.last_visit.specialist_name, card.last_visit.service_name]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">No visit on record</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Open enquiry</dt>
          <dd>
            {card.open_enquiry ? (
              <Link href={`/enquiries?open=${card.open_enquiry.id}`} className="underline">
                #{card.open_enquiry.number} {card.open_enquiry.title}
                {card.open_enquiry.stage ? ` (${card.open_enquiry.stage})` : ""}
              </Link>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
      </dl>

      {(card.household.guardian || card.household.dependants.length > 0 || can.contacts) && (
        <div className="border-t pt-2">
          <p className="mb-1 flex items-center gap-1 text-xs font-medium">
            <UsersRound className="size-3.5" /> Household
          </p>
          {card.household.guardian && (
            <p className="text-xs">
              Dependant of <span className="font-medium">{card.household.guardian.name}</span>
              {" · "}reminders go to their number
            </p>
          )}
          {card.household.dependants.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs">
              {card.household.dependants.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <span>
                    {d.name}
                    {d.next_starts_at && (
                      <span className="text-muted-foreground">
                        {" "}
                        · next {when(d.next_starts_at, tz)}
                      </span>
                    )}
                  </span>
                  {can.contacts && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground underline"
                      disabled={pending}
                      onClick={() =>
                        confirm(`Unlink ${d.name} from this household?`) &&
                        run(() => unlinkDependant(d.link_id))
                      }
                    >
                      Unlink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {can.contacts && !card.household.guardian && (
            <DependantDialog guardianId={c.id} guardianName={c.name} onDone={onChanged} />
          )}
        </div>
      )}

      {card.waitlist.length > 0 && (
        <div className="border-t pt-2">
          <p className="mb-1 flex items-center gap-1 text-xs font-medium">
            <Hourglass className="size-3.5" /> Waiting for
          </p>
          <ul className="flex flex-col gap-0.5 text-xs">
            {card.waitlist.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2">
                <span>
                  {[w.specialist_name, w.service_name].filter(Boolean).join(" · ") || "Any"}
                </span>
                {can.appointments && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground underline"
                    disabled={pending}
                    onClick={() => run(() => removeFromWaitlist(w.id))}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t pt-3" role="group" aria-label="One-tap actions">
        {can.appointments && (
          <Button size="sm" asChild>
            <Link href={`/appointments?new=${c.id}`}>
              <CalendarPlus /> Book
            </Link>
          </Button>
        )}
        {can.appointments && next && next.status !== "cancelled" && (
          <RescheduleDialog appointmentId={next.id} options={options} onDone={onChanged}>
            <Button size="sm" variant="outline">
              <CalendarClock /> Move
            </Button>
          </RescheduleDialog>
        )}
        {can.appointments && next && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (!confirm("Cancel this appointment? The slot goes back on offer.")) return;
              const notify = confirm("Send the patient a cancellation message as well?");
              run(() => cancelFromDesk({ appointmentId: next.id, notify }));
            }}
          >
            <CalendarX2 /> Cancel
          </Button>
        )}
        {callPhone ? (
          <Button size="sm" variant="outline" asChild>
            <a
              href={`tel:${callPhone}`}
              onClick={() => {
                // The browser opens the dialler; the call is logged as a task alongside.
                if (can.tasks)
                  void logCall(c.id).then((r) => r.ok && r.message && toast.success(r.message));
              }}
            >
              <Phone /> Call
            </a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled title="No phone number on file">
            <Phone /> Call
          </Button>
        )}
        {can.send && (
          <>
            {/* With an upcoming visit the message names that visit's branch; otherwise the desk picks the branch,
                never the first one by name. */}
            {!next && options.locations.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={pending}>
                    {pending ? <Loader2 className="animate-spin" /> : <MapPin />} Location
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Send which branch?</DropdownMenuLabel>
                  {options.locations.map((l) => (
                    <DropdownMenuItem
                      key={l.id}
                      onSelect={() =>
                        run(() =>
                          sendDeskMessageAction({
                            contactId: c.id,
                            kind: "location",
                            locationId: l.id,
                          }),
                        )
                      }
                    >
                      {l.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    sendDeskMessageAction({
                      contactId: c.id,
                      kind: "location",
                      locationId: next ? undefined : options.locations[0]?.id,
                    }),
                  )
                }
              >
                {pending ? <Loader2 className="animate-spin" /> : <MapPin />} Location
              </Button>
            )}
            <span className="flex items-center gap-1">
              <Select value={late} onValueChange={setLate}>
                <SelectTrigger size="sm" className="w-24" aria-label="Minutes late">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LATE_MINUTE_CHOICES.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    sendDeskMessageAction({
                      contactId: c.id,
                      kind: "running_late",
                      minutes: Number(late),
                    }),
                  )
                }
              >
                <Clock /> Running late
              </Button>
            </span>
          </>
        )}
        {can.appointments && (
          <WaitlistDialog contactId={c.id} options={options} onDone={onChanged} />
        )}
      </div>
    </section>
  );
}
