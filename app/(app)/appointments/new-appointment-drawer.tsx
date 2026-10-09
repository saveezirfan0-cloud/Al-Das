"use client";

import * as React from "react";
import { fromZonedTime } from "date-fns-tz";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { createContact, searchContactsQuick } from "../contacts/actions";
import { blockTime, bookAppointment, getFreeSlots } from "./actions";
import { timeLabel } from "./format";
import type { AppointmentsBootstrap, SlotOption } from "./types";

export type NewAppointmentDefaults = {
  locationId?: string;
  specialistId?: string;
  date?: string;
  startIso?: string;
  contact?: { id: string; name: string; phone: string | null };
  tab?: "single" | "block";
};

type Patient = { id: string; name: string; phone: string | null };

function PatientPicker({
  value,
  onChange,
}: {
  value: Patient | null;
  onChange: (p: Patient | null) => void;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Patient[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState({ first_name: "", last_name: "", phone: "" });
  const [saving, startSave] = React.useTransition();

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const h = setTimeout(() => {
      void searchContactsQuick(q.trim()).then((res) => {
        if (cancelled) return;
        setSearching(false);
        if (res.ok)
          setResults(
            res.data.rows.map((r) => ({
              id: r.id,
              name: r.full_name || r.phone_e164 || "Unnamed",
              phone: r.phone_e164,
            })),
          );
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [q]);

  if (value)
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{value.name}</span>
          {value.phone && <span className="text-muted-foreground"> · {value.phone}</span>}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Change patient"
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      </div>
    );

  if (adding)
    return (
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="First name"
            value={draft.first_name}
            onChange={(e) => setDraft({ ...draft, first_name: e.target.value })}
          />
          <Input
            placeholder="Last name"
            value={draft.last_name}
            onChange={(e) => setDraft({ ...draft, last_name: e.target.value })}
          />
        </div>
        <Input
          placeholder="Phone (e.g. +971 50 000 0000)"
          value={draft.phone}
          onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(false)}>
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || (!draft.first_name && !draft.phone)}
            onClick={() =>
              startSave(async () => {
                const res = await createContact(draft);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                onChange({
                  id: res.data.id,
                  name: `${draft.first_name} ${draft.last_name}`.trim() || draft.phone,
                  phone: draft.phone || null,
                });
                setAdding(false);
              })
            }
          >
            {saving && <Loader2 className="animate-spin" />} Create patient
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
        <Input
          className="pl-8"
          placeholder="Search by name, phone or Unite ID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {searching && <span className="text-muted-foreground text-xs">Searching…</span>}
      {results.length > 0 && (
        <ul className="max-h-48 divide-y overflow-auto rounded-md border text-sm">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center justify-between px-3 py-2 text-left"
                onClick={() => onChange(r)}
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground text-xs">{r.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setAdding(true)}
      >
        <UserPlus /> Add new patient
      </Button>
    </div>
  );
}

export function NewAppointmentDrawer({
  open,
  onOpenChange,
  bootstrap,
  defaults,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: AppointmentsBootstrap;
  defaults: NewAppointmentDefaults;
  onDone: () => void;
}) {
  const [tab, setTab] = React.useState<"single" | "block">("single");
  const [patient, setPatient] = React.useState<Patient | null>(null);
  const [locationId, setLocationId] = React.useState("");
  const [specialistId, setSpecialistId] = React.useState("");
  const [serviceId, setServiceId] = React.useState("");
  const [date, setDate] = React.useState(bootstrap.today);
  const [startIso, setStartIso] = React.useState("");
  const [manual, setManual] = React.useState(false);
  const [manualTime, setManualTime] = React.useState("09:00");
  const [notify, setNotify] = React.useState(false);
  const [notifyEarly, setNotifyEarly] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [slots, setSlots] = React.useState<SlotOption[] | null>(null);
  const [loadingSlots, setLoadingSlots] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  // block-time fields
  const [blockFrom, setBlockFrom] = React.useState("09:00");
  const [blockTo, setBlockTo] = React.useState("10:00");
  const [blockReason, setBlockReason] = React.useState("");

  // Reset whenever the drawer opens with fresh defaults.
  React.useEffect(() => {
    if (!open) return;
    const loc = defaults.locationId ?? bootstrap.locations[0]?.id ?? "";
    setTab(defaults.tab ?? "single");
    setPatient(defaults.contact ?? null);
    setLocationId(loc);
    setSpecialistId(defaults.specialistId ?? "");
    setServiceId("");
    setDate(defaults.date ?? bootstrap.today);
    setStartIso(defaults.startIso ?? "");
    setManual(false);
    setNotify(false);
    setNotifyEarly(false);
    setNotes("");
    setSlots(null);
    setBlockReason("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults]);

  const location = bootstrap.locations.find((l) => l.id === locationId);
  const tz = location?.timezone ?? bootstrap.timezone;
  const specialistsHere = bootstrap.specialists.filter(
    (s) => !locationId || s.location_ids.includes(locationId),
  );
  const specialist = bootstrap.specialists.find((s) => s.id === specialistId);
  const servicesFor = bootstrap.services.filter(
    (s) =>
      !specialist || specialist.service_ids.length === 0 || specialist.service_ids.includes(s.id),
  );
  const service = bootstrap.services.find((s) => s.id === serviceId);

  // Drop selections that no longer fit the location / specialist.
  React.useEffect(() => {
    if (specialistId && !specialistsHere.some((s) => s.id === specialistId)) setSpecialistId("");
  }, [specialistId, specialistsHere]);
  React.useEffect(() => {
    if (serviceId && !servicesFor.some((s) => s.id === serviceId)) setServiceId("");
  }, [serviceId, servicesFor]);

  // Load the slot list.
  React.useEffect(() => {
    if (!open || tab !== "single" || !locationId || !specialistId || !serviceId || !date) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    void getFreeSlots({ locationId, specialistId, serviceId, date }).then((res) => {
      if (cancelled) return;
      setLoadingSlots(false);
      if (res.ok && res.data) {
        setSlots(res.data.slots);
        // keep a pre-clicked start only when it is still a free slot
        setStartIso((cur) => (res.data!.slots.some((s) => s.start === cur) ? cur : ""));
      } else if (!res.ok) toast.error(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, tab, locationId, specialistId, serviceId, date]);

  const effectiveStart = manual
    ? fromZonedTime(`${date}T${manualTime}:00`, tz).toISOString()
    : startIso;
  const endLabel =
    effectiveStart && service
      ? timeLabel(
          new Date(
            new Date(effectiveStart).getTime() + service.duration_min * 60_000,
          ).toISOString(),
          tz,
        )
      : "";
  const confirmedMapped = !!bootstrap.rules.templates.confirmed;

  function submitSingle() {
    if (!patient) return toast.error("Choose a patient.");
    if (!effectiveStart) return toast.error("Choose a start time.");
    startTransition(async () => {
      const res = await bookAppointment({
        contactId: patient.id,
        locationId,
        specialistId,
        serviceId,
        startsAt: effectiveStart,
        notes: notes || null,
        notifyEarly,
        notify,
        override: manual,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      if (notify && res.data && !res.data.notified)
        toast.warning(`Booked, but the patient was not notified: ${res.data.notifyError}`);
      onOpenChange(false);
      onDone();
    });
  }

  function submitBlock() {
    if (!specialistId) return toast.error("Choose a specialist.");
    const startsAt = fromZonedTime(`${date}T${blockFrom}:00`, tz);
    const endsAt = fromZonedTime(`${date}T${blockTo}:00`, tz);
    startTransition(async () => {
      const res = await blockTime({
        specialistId,
        locationId: locationId || null,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: blockReason || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      onOpenChange(false);
      onDone();
    });
  }

  const field = (label: string, node: React.ReactNode, required = false) => (
    <div className="flex flex-col gap-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {node}
    </div>
  );
  const selectOf = (
    value: string,
    onChange: (v: string) => void,
    items: Array<{ id: string; name: string }>,
    placeholder: string,
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const place = (
    <>
      {field(
        "Location",
        selectOf(locationId, setLocationId, bootstrap.locations, "Choose a location"),
        true,
      )}
      {field(
        "Specialist",
        selectOf(specialistId, setSpecialistId, specialistsHere, "Choose a specialist"),
        true,
      )}
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New appointment</SheetTitle>
          <SheetDescription>
            Book a patient or block time in a specialist&apos;s diary.
          </SheetDescription>
        </SheetHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="flex flex-col gap-4 px-4 pb-4"
        >
          <TabsList className="w-full">
            <TabsTrigger value="single">Single appointment</TabsTrigger>
            <TabsTrigger value="block">Block time period</TabsTrigger>
          </TabsList>

          <TabsContent value="single" className="flex flex-col gap-4">
            {field("Patient", <PatientPicker value={patient} onChange={setPatient} />, true)}
            {place}
            {field(
              "Service",
              selectOf(serviceId, setServiceId, servicesFor, "Choose a service"),
              true,
            )}
            {field(
              "Date",
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />,
              true,
            )}
            {field(
              "Start time",
              <div className="flex flex-col gap-2">
                {!manual && (
                  <>
                    {!locationId || !specialistId || !serviceId ? (
                      <p className="text-muted-foreground text-xs">
                        Choose a location, specialist and service to see free times.
                      </p>
                    ) : loadingSlots ? (
                      <p className="text-muted-foreground flex items-center gap-1 text-xs">
                        <Loader2 className="size-3 animate-spin" /> Loading free times…
                      </p>
                    ) : slots && slots.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        No free times that day. Pick another date, or book outside hours below.
                      </p>
                    ) : (
                      <div className="grid grid-cols-4 gap-1.5">
                        {(slots ?? []).map((s) => (
                          <Button
                            key={s.start}
                            type="button"
                            size="sm"
                            variant={startIso === s.start ? "default" : "outline"}
                            aria-pressed={startIso === s.start}
                            onClick={() => setStartIso(s.start)}
                          >
                            {s.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={manual} onCheckedChange={setManual} />
                  Book outside available hours
                </label>
                {manual && (
                  <Input
                    type="time"
                    className="w-36"
                    value={manualTime}
                    onChange={(e) => setManualTime(e.target.value)}
                  />
                )}
              </div>,
              true,
            )}
            {field(
              "End time",
              <Input readOnly value={endLabel} placeholder="Set by the service duration" />,
            )}
            <label className="flex items-start gap-2 text-sm">
              <Switch checked={notify} onCheckedChange={setNotify} disabled={!confirmedMapped} />
              <span>
                Notify patient on WhatsApp
                {!confirmedMapped && (
                  <span className="text-muted-foreground block text-xs">
                    Map a &ldquo;Booking confirmed&rdquo; template in Settings → Appointments.
                  </span>
                )}
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={notifyEarly} onCheckedChange={setNotifyEarly} />
              Notify the patient if an earlier slot opens
            </label>
            {field(
              "Notes",
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />,
            )}
            <Button
              onClick={submitSingle}
              disabled={pending || !patient || !serviceId || !effectiveStart}
            >
              {pending && <Loader2 className="animate-spin" />} Book appointment
            </Button>
          </TabsContent>

          <TabsContent value="block" className="flex flex-col gap-4">
            {field(
              "Location",
              selectOf(locationId, setLocationId, bootstrap.locations, "Choose a location"),
            )}
            {field(
              "Specialist",
              selectOf(specialistId, setSpecialistId, specialistsHere, "Choose a specialist"),
              true,
            )}
            {field(
              "Date",
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />,
              true,
            )}
            <div className="grid grid-cols-2 gap-3">
              {field(
                "From",
                <Input
                  type="time"
                  value={blockFrom}
                  onChange={(e) => setBlockFrom(e.target.value)}
                />,
                true,
              )}
              {field(
                "To",
                <Input type="time" value={blockTo} onChange={(e) => setBlockTo(e.target.value)} />,
                true,
              )}
            </div>
            {field(
              "Reason",
              <Input
                value={blockReason}
                placeholder="e.g. Meeting, leave, training"
                onChange={(e) => setBlockReason(e.target.value)}
              />,
            )}
            <Button onClick={submitBlock} disabled={pending || !specialistId}>
              {pending && <Loader2 className="animate-spin" />} Block time
            </Button>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
