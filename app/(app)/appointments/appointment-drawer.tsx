"use client";

import * as React from "react";
import Link from "next/link";
import { RecordHistorySection } from "@/components/history/record-history";
import { useConfirm } from "@/components/shell/confirm-dialog";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { localDate } from "@/lib/appointments/slots";
import { canTransition, STATUS_LABELS, type AppointmentStatus } from "@/lib/appointments/status";
import { effectiveVisitMode, isVisitMode } from "@/lib/integrations/telehealth/policy";
import { money } from "@/lib/finance/format";
import { cn } from "@/lib/utils";

import {
  getAppointmentDetail,
  getAppointmentInvoices,
  getFreeSlots,
  getVideoJoinLink,
  moveAppointment,
  sendReminderNow,
  setStatus,
  setVisitMode,
  updateAppointmentNotes,
} from "./actions";
import { CheckinBadge } from "./checkin-badge";
import { CONFLICT_TEXT } from "./conflict-badge";
import { dateTimeLabel, REMINDER_LABELS, STATUS_STYLES, timeLabel } from "./format";
import type { AppointmentsBootstrap, ApptDetail, SlotOption } from "./types";

const STATUS_ACTIONS: Array<{
  to: AppointmentStatus;
  label: string;
  variant: "default" | "outline" | "destructive";
}> = [
  { to: "confirmed", label: "Confirm", variant: "default" },
  { to: "completed", label: "Complete", variant: "outline" },
  { to: "no_show", label: "No-show", variant: "outline" },
  { to: "cancelled", label: "Cancel", variant: "destructive" },
  { to: "awaiting", label: "Mark awaiting", variant: "outline" },
];

const EVENT_LABELS: Record<string, string> = {
  "appointment.created": "Booked",
  "appointment.status_changed": "Status changed",
  "appointment.rescheduled": "Rescheduled",
  "appointment.reply": "Patient replied",
};

export function AppointmentDrawer({
  id,
  bootstrap,
  onClose,
  onChanged,
}: {
  id: string | null;
  bootstrap: AppointmentsBootstrap;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = React.useState<ApptDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [notify, setNotify] = React.useState(true);
  const [notes, setNotes] = React.useState("");
  const [notifyEarly, setNotifyEarly] = React.useState(false);
  const [moving, setMoving] = React.useState(false);
  const [moveDate, setMoveDate] = React.useState("");
  const [moveSlots, setMoveSlots] = React.useState<SlotOption[] | null>(null);
  const [moveStart, setMoveStart] = React.useState("");
  const [moveNotify, setMoveNotify] = React.useState(true);
  const [version, setVersion] = React.useState(0);
  const [confirm, confirmDialog] = useConfirm();
  const [invoices, setInvoices] = React.useState<
    {
      id: string;
      number: string | null;
      date: string | null;
      net: number | null;
      paid: number | null;
    }[]
  >([]);

  // Linked Unite invoices: loaded lazily; empty (and invisible) for anyone without finance.invoices.view.
  React.useEffect(() => {
    setInvoices([]);
    if (!id) return;
    let cancelled = false;
    void getAppointmentInvoices(id).then((res) => {
      if (!cancelled && res.ok && res.data) setInvoices(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  React.useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getAppointmentDetail(id).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok && res.data) {
        setDetail(res.data);
        setNotes(res.data.appointment.notes ?? "");
        setNotifyEarly(res.data.appointment.notify_early);
        const apptTz =
          bootstrap.locations.find((l) => l.id === res.data!.appointment.location_id)?.timezone ??
          bootstrap.timezone;
        setMoveDate(localDate(new Date(res.data.appointment.starts_at), apptTz));
        setMoving(false);
        setMoveStart("");
      } else if (!res.ok) {
        toast.error(res.error);
        onClose();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]);

  const a = detail?.appointment;
  const location = bootstrap.locations.find((l) => l.id === a?.location_id);
  const tz = location?.timezone ?? bootstrap.timezone;
  const specialist = bootstrap.specialists.find((s) => s.id === a?.specialist_id);
  const service = bootstrap.services.find((s) => s.id === a?.service_id);
  const isUnite = a?.source === "unite";
  const visitMode = effectiveVisitMode(a?.visit_mode, service?.default_visit_mode);
  const videoLive =
    visitMode === "video" && a && a.status !== "cancelled" && a.status !== "no_show";

  // Slots for the reschedule picker.
  React.useEffect(() => {
    if (!moving || !a?.location_id || !a.specialist_id || !a.service_id || !moveDate) return;
    let cancelled = false;
    void getFreeSlots({
      locationId: a.location_id,
      specialistId: a.specialist_id,
      serviceId: a.service_id,
      date: moveDate,
      excludeAppointmentId: a.id,
    }).then((res) => {
      if (!cancelled && res.ok && res.data) setMoveSlots(res.data.slots);
    });
    return () => {
      cancelled = true;
    };
  }, [moving, moveDate, a?.id, a?.location_id, a?.specialist_id, a?.service_id]);

  function reload() {
    setVersion((v) => v + 1);
    onChanged();
  }

  function changeStatus(to: AppointmentStatus) {
    if (!a) return;
    startTransition(async () => {
      const res = await setStatus({ id: a.id, to, notify });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      if (notify && res.data && !res.data.notified && res.data.notifyError)
        toast.warning(`Patient not notified: ${res.data.notifyError}`);
      reload();
    });
  }

  function submitMove() {
    if (!a || !moveStart) return;
    startTransition(async () => {
      const res = await moveAppointment({ id: a.id, startsAt: moveStart, notify: moveNotify });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      if (moveNotify && res.data && !res.data.notified && res.data.notifyError)
        toast.warning(`Patient not notified: ${res.data.notifyError}`);
      reload();
    });
  }

  function joinVideo(renew = false) {
    if (!a) return;
    startTransition(async () => {
      const res = await getVideoJoinLink({ id: a.id, renew });
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "No link." : res.error);
        return;
      }
      if (renew) {
        try {
          await navigator.clipboard.writeText(res.data.url);
          toast.success("New link made and copied. The old link no longer works.");
        } catch {
          toast.success("New link made. The old link no longer works.");
        }
      } else window.open(res.data.url, "_blank", "noopener,noreferrer");
    });
  }

  function copyVideo() {
    if (!a) return;
    startTransition(async () => {
      const res = await getVideoJoinLink({ id: a.id });
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "No link." : res.error);
        return;
      }
      try {
        await navigator.clipboard.writeText(res.data.url);
        toast.success("Link copied.");
      } catch {
        toast.error("Could not copy the link.");
      }
    });
  }

  function changeVisitMode(value: string) {
    if (!a) return;
    const mode = isVisitMode(value) ? value : null;
    startTransition(async () => {
      const res = await setVisitMode({ id: a.id, mode });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      reload();
    });
  }

  const tpl = bootstrap.rules.templates;

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{a ? `Appointment #${a.number}` : "Appointment"}</SheetTitle>
          <SheetDescription>
            {a ? dateTimeLabel(a.starts_at, tz) + ` – ${timeLabel(a.ends_at, tz)}` : "Loading…"}
          </SheetDescription>
        </SheetHeader>
        {loading && !a && <p className="text-muted-foreground px-4 text-sm">Loading…</p>}
        {a && detail && (
          <div className="flex flex-col gap-5 px-4 pb-6">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded border px-2 py-0.5 text-xs",
                  STATUS_STYLES[a.status].replace("line-through", ""),
                )}
              >
                {STATUS_LABELS[a.status]}
              </span>
              <CheckinBadge value={a.checkin_status} className="px-1.5 py-0.5 text-xs" />
              {isUnite && <Badge variant="outline">Unite {a.external_id}</Badge>}
              {a.conflict && (
                <Badge
                  variant="outline"
                  className="border-amber-500 text-amber-700 dark:text-amber-400"
                  title={CONFLICT_TEXT[a.conflict]}
                >
                  Booking conflict
                </Badge>
              )}
              {a.reminder && (
                <Badge variant={a.reminder === "failed" ? "destructive" : "outline"}>
                  Reminder: {REMINDER_LABELS[a.reminder]}
                </Badge>
              )}
            </div>

            <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Patient</dt>
              <dd className="flex items-center gap-1 font-medium">
                {a.contact_id ? (
                  <Link className="hover:underline" href={`/contacts?contact=${a.contact_id}`}>
                    {a.contact_name} <ExternalLink className="inline size-3" />
                  </Link>
                ) : (
                  <span>
                    {a.contact_name}{" "}
                    <span className="text-muted-foreground text-xs font-normal">
                      (in Sync review)
                    </span>
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="tabular-nums">{a.phone ?? "—"}</dd>
              <dt className="text-muted-foreground">Location</dt>
              <dd>{location?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Specialist</dt>
              <dd>{specialist?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Service</dt>
              <dd>{service?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="capitalize">{a.source}</dd>
              <dt className="text-muted-foreground">Visit type</dt>
              <dd>
                {bootstrap.can.manage ? (
                  <select
                    aria-label="Visit type"
                    className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                    value={a.visit_mode ?? ""}
                    disabled={pending}
                    onChange={(e) => changeVisitMode(e.target.value)}
                  >
                    <option value="">
                      Follow the service (
                      {service?.default_visit_mode === "video" ? "video" : "in person"})
                    </option>
                    <option value="in_person">In person</option>
                    <option value="video">Video</option>
                  </select>
                ) : visitMode === "video" ? (
                  "Video"
                ) : (
                  "In person"
                )}
              </dd>
            </dl>

            {videoLive && (
              <section className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                <Button size="sm" disabled={pending} onClick={() => joinVideo(false)}>
                  Join video visit
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={copyVideo}>
                  Copy link
                </Button>
                {bootstrap.can.manage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Make a new link?",
                        description:
                          "The old link stops working. Use this if the link was shared by mistake.",
                        confirmLabel: "Make a new link",
                      });
                      if (ok) joinVideo(true);
                    }}
                  >
                    New link
                  </Button>
                )}
                <p className="text-muted-foreground w-full text-xs">
                  The link is private to this appointment and stops working after the visit.
                </p>
              </section>
            )}

            {bootstrap.can.manage && !isUnite && (
              <section className="flex flex-col gap-2">
                <Label>Change status</Label>
                <div className="flex flex-wrap gap-2">
                  {STATUS_ACTIONS.filter((s) => canTransition(a.status, s.to)).map((s) => (
                    <Button
                      key={s.to}
                      size="sm"
                      variant={s.variant}
                      disabled={pending}
                      onClick={() => changeStatus(s.to)}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={notify} onCheckedChange={setNotify} />
                  Notify the patient on WhatsApp when confirming or cancelling (needs a mapped
                  template)
                </label>
              </section>
            )}
            {isUnite && (
              <p className="text-muted-foreground rounded-md border p-3 text-xs">
                This appointment is synced from Unite, which stays the source of truth. Status and
                time changes are made there and arrive here on the next sync.
              </p>
            )}
            {a.conflict && (
              <p className="rounded-md border border-amber-500/60 p-3 text-xs">
                {CONFLICT_TEXT[a.conflict]}{" "}
                {isUnite
                  ? "It was booked in Unite and is kept exactly as Unite has it; resolve it in Unite if needed."
                  : "This can follow a Unite booking, a change to the rules or a staff override."}
              </p>
            )}

            {bootstrap.can.manage &&
              !isUnite &&
              a.status !== "cancelled" &&
              a.status !== "completed" && (
                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Reschedule</Label>
                    <Button size="sm" variant="ghost" onClick={() => setMoving((m) => !m)}>
                      {moving ? "Close" : "Pick a new time"}
                    </Button>
                  </div>
                  {moving && (
                    <div className="flex flex-col gap-2 rounded-md border p-3">
                      <Input
                        type="date"
                        value={moveDate}
                        onChange={(e) => setMoveDate(e.target.value)}
                      />
                      {moveSlots && moveSlots.length === 0 && (
                        <p className="text-muted-foreground text-xs">No free times that day.</p>
                      )}
                      <div className="grid grid-cols-4 gap-1.5">
                        {(moveSlots ?? []).map((s) => (
                          <Button
                            key={s.start}
                            size="sm"
                            variant={moveStart === s.start ? "default" : "outline"}
                            onClick={() => setMoveStart(s.start)}
                          >
                            {s.label}
                          </Button>
                        ))}
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={moveNotify}
                          onCheckedChange={setMoveNotify}
                          disabled={!tpl.rescheduled}
                        />
                        Notify the patient
                        {!tpl.rescheduled && " (map a Rescheduled template first)"}
                      </label>
                      <Button size="sm" disabled={pending || !moveStart} onClick={submitMove}>
                        {pending && <Loader2 className="animate-spin" />} Move appointment
                      </Button>
                    </div>
                  )}
                </section>
              )}

            {invoices.length > 0 && (
              <section className="flex flex-col gap-2">
                <Label>Invoices</Label>
                <ul className="divide-y text-sm">
                  {invoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-2 py-1.5">
                      <Link href={`/finance/invoices/${inv.id}`} className="hover:underline">
                        {inv.number ?? "Invoice"}
                      </Link>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {inv.date ?? "–"} · Net {money(inv.net)} · Paid {money(inv.paid)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="flex flex-col gap-2">
              <Label htmlFor="appt-notes">Notes</Label>
              <Textarea
                id="appt-notes"
                rows={3}
                value={notes}
                disabled={!bootstrap.can.manage}
                onChange={(e) => setNotes(e.target.value)}
              />
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={notifyEarly}
                  onCheckedChange={setNotifyEarly}
                  disabled={!bootstrap.can.manage}
                />
                Notify the patient if an earlier slot opens
              </label>
              {bootstrap.can.manage && (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={
                    pending || (notes === (a.notes ?? "") && notifyEarly === a.notify_early)
                  }
                  onClick={() =>
                    startTransition(async () => {
                      const res = await updateAppointmentNotes({ id: a.id, notes, notifyEarly });
                      if (res.ok) {
                        toast.success(res.message);
                        reload();
                      } else toast.error(res.error);
                    })
                  }
                >
                  Save notes
                </Button>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Reminders</Label>
                {bootstrap.can.manage && tpl.reminder && a.contact_id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const res = await sendReminderNow(a.id);
                        if (res.ok) toast.success(res.message);
                        else toast.error(res.error);
                        reload();
                      })
                    }
                  >
                    Send reminder now
                  </Button>
                )}
              </div>
              {detail.reminders.length === 0 ? (
                <p className="text-muted-foreground text-xs">No reminders scheduled.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {detail.reminders.map((r) => (
                    <li key={r.idx} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span>
                        #{r.idx} · {dateTimeLabel(r.due_at, tz)}
                        {r.exclusion_reason && (
                          <span className="text-muted-foreground block text-xs">
                            Excluded: {r.exclusion_reason.replace(/_/g, " ")}
                          </span>
                        )}
                        {r.error && (
                          <span className="text-destructive block text-xs">{r.error}</span>
                        )}
                      </span>
                      <Badge variant={r.status === "failed" ? "destructive" : "outline"}>
                        {REMINDER_LABELS[r.status] ?? r.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <Label>History</Label>
              {detail.history.length === 0 ? (
                <p className="text-muted-foreground text-xs">Nothing recorded yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {detail.history.map((h) => (
                    <li key={h.id} className="flex justify-between gap-2">
                      <span>
                        {EVENT_LABELS[h.type] ?? h.type}
                        {typeof h.payload.to === "string" &&
                          h.type === "appointment.status_changed" && (
                            <span className="text-muted-foreground">
                              {" "}
                              → {h.payload.to.replace("_", "-")}
                            </span>
                          )}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {dateTimeLabel(h.at, tz)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <Label>Field changes</Label>
              <RecordHistorySection table="appointments" recordId={a.id} />
            </section>
          </div>
        )}
        {confirmDialog}
      </SheetContent>
    </Sheet>
  );
}
