"use client";

import { useEffect, useState, useTransition } from "react";
import { Hourglass, Loader2, UserPlus, UsersRound } from "lucide-react";
import { toast } from "sonner";

import { getFreeSlots, moveAppointment } from "@/app/(app)/appointments/actions";
import { searchContactsQuick } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatPhone } from "@/lib/phone";

import { addToWaitlist, createDependant, linkDependant } from "./actions";
import type { DeskOptions } from "./types";

const ANY = "__any__";

/** Move an appointment to another free slot: pick the day, then one of the times the slot engine offers. */
export function RescheduleDialog({
  appointmentId,
  options,
  onDone,
  children,
}: {
  appointmentId: string;
  options: DeskOptions;
  onDone?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [date, setDate] = useState("");
  const [specialistId, setSpecialistId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [serviceId, setServiceId] = useState<string>("");
  const [slots, setSlots] = useState<Array<{ start: string; label: string }> | null>(null);
  const [start, setStart] = useState("");
  const [notify, setNotify] = useState(true);

  const doctor = options.specialists.find((s) => s.id === specialistId);

  useEffect(() => {
    setSlots(null);
    setStart("");
    if (!open || !date || !specialistId || !locationId || !serviceId) return;
    let cancelled = false;
    void getFreeSlots({
      specialistId,
      locationId,
      serviceId,
      date,
      excludeAppointmentId: appointmentId,
    }).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data) setSlots(r.data.slots);
      else if (!r.ok) toast.error(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, date, specialistId, locationId, serviceId, appointmentId]);

  function save() {
    startTransition(async () => {
      const r = await moveAppointment({
        id: appointmentId,
        startsAt: start,
        specialistId,
        locationId,
        notify,
      });
      if (r.ok) {
        toast.success(r.message ?? "Appointment moved.");
        if (r.data?.notifyError) toast.warning(r.data.notifyError);
        setOpen(false);
        onDone?.();
      } else toast.error(r.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move appointment</DialogTitle>
          <DialogDescription>
            Choose the doctor, the day and one of the free times.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>Place</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a place" />
              </SelectTrigger>
              <SelectContent>
                {options.locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Doctor</Label>
            <Select
              value={specialistId}
              onValueChange={(v) => {
                setSpecialistId(v);
                setServiceId("");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a doctor" />
              </SelectTrigger>
              <SelectContent>
                {options.specialists
                  .filter((s) => !locationId || s.location_ids.includes(locationId))
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Service</Label>
            <Select value={serviceId} onValueChange={setServiceId} disabled={!doctor}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a service" />
              </SelectTrigger>
              <SelectContent>
                {options.services
                  .filter((s) => doctor?.service_ids.includes(s.id))
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.duration_min} min)
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="move-date">Day</Label>
            <Input
              id="move-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label>Free times</Label>
            {slots === null ? (
              <p className="text-muted-foreground text-xs">
                Choose place, doctor, service and day to see times.
              </p>
            ) : slots.length === 0 ? (
              <p className="text-muted-foreground text-xs">No free time that day.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <Button
                    key={s.start}
                    type="button"
                    size="xs"
                    variant={start === s.start ? "default" : "outline"}
                    onClick={() => setStart(s.start)}
                  >
                    {s.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Tell the patient about the new time
          </label>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={pending || !start}>
            {pending && <Loader2 className="animate-spin" />} Move appointment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Add this patient to the waiting list for a doctor and/or a service. */
export function WaitlistDialog({
  contactId,
  options,
  onDone,
}: {
  contactId: string;
  options: DeskOptions;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [specialistId, setSpecialistId] = useState(ANY);
  const [serviceId, setServiceId] = useState(ANY);
  const [locationId, setLocationId] = useState(ANY);
  const [notAfter, setNotAfter] = useState("");
  const [notes, setNotes] = useState("");

  const doctor = options.specialists.find((s) => s.id === specialistId);
  const services = options.services.filter((s) => !doctor || doctor.service_ids.includes(s.id));

  function save() {
    startTransition(async () => {
      const r = await addToWaitlist({
        contactId,
        specialistId: specialistId === ANY ? undefined : specialistId,
        serviceId: serviceId === ANY ? undefined : serviceId,
        locationId: locationId === ANY ? undefined : locationId,
        notAfter: notAfter || undefined,
        notes: notes || undefined,
      });
      if (r.ok) {
        toast.success(r.message ?? "Added.");
        setOpen(false);
        onDone?.();
      } else toast.error(r.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Hourglass /> Waitlist
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to the waiting list</DialogTitle>
          <DialogDescription>
            When a matching appointment is cancelled, the patient can be offered the slot on
            WhatsApp.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>Doctor</Label>
            <Select value={specialistId} onValueChange={setSpecialistId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any doctor</SelectItem>
                {options.specialists.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Service</Label>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any service</SelectItem>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Place</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any place</SelectItem>
                {options.locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="wl-until">Only until (optional)</Label>
            <Input
              id="wl-until"
              type="date"
              value={notAfter}
              onChange={(e) => setNotAfter(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="wl-notes">Note (optional, no medical details)</Label>
            <Textarea
              id="wl-notes"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {specialistId === ANY && serviceId === ANY && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Choose a doctor, a service, or both.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={pending || (specialistId === ANY && serviceId === ANY)}>
            {pending && <Loader2 className="animate-spin" />} Add to the list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Found = { id: string; name: string; phone: string | null };

/** Add a dependant under this guardian: a brand-new person (no phone of their own) or an existing record. */
export function DependantDialog({
  guardianId,
  guardianName,
  onDone,
}: {
  guardianId: string;
  guardianName: string;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      void searchContactsQuick(q.trim(), guardianId).then((r) => {
        if (!cancelled && r.ok && r.data)
          setFound(
            r.data.rows.map((x) => ({
              id: x.id,
              name: x.full_name || "Unnamed",
              phone: x.phone_e164 ? formatPhone(x.phone_e164) : null,
            })),
          );
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [q, guardianId]);

  function done(message?: string) {
    if (message) toast.success(message);
    setOpen(false);
    setName("");
    setDob("");
    setQ("");
    onDone?.();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-xs underline"
        >
          <UserPlus className="size-3.5" /> Add a dependant
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <UsersRound className="mr-1 inline size-4" /> Dependant of {guardianName}
          </DialogTitle>
          <DialogDescription>
            Reminders for a dependant go to {guardianName}&apos;s WhatsApp and name the patient.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs font-medium">New person</p>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input
              type="date"
              aria-label="Date of birth"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={pending || name.trim().length < 2}
            onClick={() =>
              startTransition(async () => {
                const r = await createDependant({ guardianId, name, dob: dob || undefined });
                if (r.ok) done(r.message);
                else toast.error(r.error);
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Add new dependant
          </Button>
          <p className="mt-2 text-xs font-medium">Or link an existing patient record</p>
          <Input
            placeholder="Search by name or phone"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {found.length > 0 && (
            <ul className="divide-y rounded-md border text-sm">
              {found.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {f.name} <span className="text-muted-foreground text-xs">{f.phone}</span>
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await linkDependant({ guardianId, dependantId: f.id });
                        if (r.ok) done(r.message);
                        else toast.error(r.error);
                      })
                    }
                  >
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
