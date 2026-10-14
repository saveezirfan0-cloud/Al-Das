"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { CalendarPlus, Loader2, Printer, X } from "lucide-react";
import { toast } from "sonner";

import { bookAppointment } from "@/app/(app)/appointments/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  doctorsForBooking,
  presetBranch,
  servicesAtBranch,
  type DoctorDay,
} from "@/lib/front-desk/book";

import { getDeskDaySlots } from "./actions";
import { PatientSearch, type FoundPatient } from "./patient-search";
import type { DeskOptions } from "./types";

const ANY = "__any__";

type Booked = { id: string; number: number };

/**
 * Book inside the desk: the branch starts on the switcher's (or home) branch, the patient comes from the desk's search,
 * and one day of free times per doctor comes from the slot engine. The booking goes through public.book_appointment
 * (bookAppointment), which takes the per-doctor lock and re-checks the slot.
 */
export function BookDrawer({
  open,
  onOpenChange,
  options,
  patient,
  initialDate,
  today,
  onBooked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: DeskOptions;
  /** The patient picked on the desk (card or board), if any. */
  patient: FoundPatient | null;
  initialDate: string;
  today: string;
  onBooked?: (b: Booked) => void;
}) {
  const [who, setWho] = useState<FoundPatient | null>(patient);
  const [locationId, setLocationId] = useState<string>(
    presetBranch(options.locations, options.currentLocationId) ?? "",
  );
  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState(ANY);
  const [date, setDate] = useState(initialDate < today ? today : initialDate);
  const [day, setDay] = useState<{
    doctors: DoctorDay[];
    full: Array<{ specialist_id: string; name: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<{ specialistId: string; start: string; label: string } | null>(
    null,
  );
  const [notify, setNotify] = useState(true);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, startTransition] = useTransition();

  // Each opening starts from the desk's current patient and a clean result.
  useEffect(() => {
    if (!open) return;
    setWho(patient);
    setBooked(null);
    setPick(null);
  }, [open, patient]);

  const services = useMemo(
    () => servicesAtBranch(options.services, options.specialists, locationId),
    [options.services, options.specialists, locationId],
  );
  const doctors = useMemo(
    () => doctorsForBooking(options.specialists, locationId, serviceId),
    [options.specialists, locationId, serviceId],
  );

  useEffect(() => {
    setDay(null);
    setPick(null);
    if (!open || !locationId || !serviceId || !date) return;
    let cancelled = false;
    setLoading(true);
    void getDeskDaySlots({
      locationId,
      serviceId,
      date,
      specialistId: doctorId === ANY ? undefined : doctorId,
    }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok && r.data) setDay(r.data);
      else if (!r.ok) toast.error(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, locationId, serviceId, doctorId, date, reloadKey]);

  function book() {
    if (!who || !pick) return;
    startTransition(async () => {
      const r = await bookAppointment({
        contactId: who.id,
        locationId,
        specialistId: pick.specialistId,
        serviceId,
        startsAt: pick.start,
        notify,
      });
      if (!r.ok) {
        toast.error(r.error);
        // The time may have just gone: show the day again as it is now.
        setReloadKey((k) => k + 1);
        return;
      }
      toast.success(r.message ?? "Booked.");
      if (notify && r.data && !r.data.notified && r.data.notifyError)
        toast.warning(`Patient not told: ${r.data.notifyError}`);
      if (r.data) {
        setBooked({ id: r.data.id, number: r.data.number });
        onBooked?.({ id: r.data.id, number: r.data.number });
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Book an appointment</SheetTitle>
          <SheetDescription>Pick the patient, the service and a free time.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {booked ? (
            <div className="flex flex-col gap-3 rounded-lg border p-4 text-sm" role="status">
              <p className="font-medium">Booked: number {booked.number}.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild>
                  <Link href={`/front-desk/slip/${booked.id}`}>
                    <Printer /> Print slip
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBooked(null);
                    setReloadKey((k) => k + 1);
                  }}
                >
                  Book another
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-1">
                <Label>Patient</Label>
                {who ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{who.name}</span>
                      {who.phone && (
                        <span className="text-muted-foreground ml-2 text-xs">{who.phone}</span>
                      )}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label="Choose another patient"
                      onClick={() => setWho(null)}
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <PatientSearch
                    onPick={setWho}
                    placeholder="Search by name or phone"
                    label="Patient to book"
                  />
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label>Branch</Label>
                  <Select
                    value={locationId}
                    onValueChange={(v) => {
                      setLocationId(v);
                      setServiceId("");
                      setDoctorId(ANY);
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Branch">
                      <SelectValue placeholder="Choose a branch" />
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
                  <Label htmlFor="desk-book-date">Day</Label>
                  <Input
                    id="desk-book-date"
                    type="date"
                    min={today}
                    value={date}
                    onChange={(e) => e.target.value && setDate(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label>Service</Label>
                  <Select
                    value={serviceId}
                    onValueChange={(v) => {
                      setServiceId(v);
                      setDoctorId(ANY);
                    }}
                    disabled={!locationId}
                  >
                    <SelectTrigger className="w-full" aria-label="Service">
                      <SelectValue placeholder="Choose a service" />
                    </SelectTrigger>
                    <SelectContent>
                      {services.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} ({s.duration_min} min)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label>Doctor</Label>
                  <Select value={doctorId} onValueChange={setDoctorId} disabled={!serviceId}>
                    <SelectTrigger className="w-full" aria-label="Doctor">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any doctor</SelectItem>
                      {doctors.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <section aria-label="Free times" className="flex flex-col gap-3">
                {!serviceId ? (
                  <p className="text-muted-foreground text-xs">
                    Choose a branch and a service to see free times.
                  </p>
                ) : loading ? (
                  <p className="text-muted-foreground flex items-center gap-2 text-xs">
                    <Loader2 className="size-3.5 animate-spin" /> Looking for free times…
                  </p>
                ) : day && day.doctors.length === 0 ? (
                  <p className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
                    No free time that day. Try another day.
                  </p>
                ) : (
                  day?.doctors.map((d) => (
                    <div key={d.specialist_id} className="rounded-md border p-3">
                      <p className="mb-2 text-sm font-medium">{d.name}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {d.slots.map((s) => {
                          const on =
                            pick?.specialistId === d.specialist_id && pick.start === s.start;
                          return (
                            <Button
                              key={s.start}
                              type="button"
                              size="xs"
                              variant={on ? "default" : "outline"}
                              aria-pressed={on}
                              aria-label={`${s.label} with ${d.name}`}
                              onClick={() =>
                                setPick({
                                  specialistId: d.specialist_id,
                                  start: s.start,
                                  label: s.label,
                                })
                              }
                            >
                              {s.label}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
                {day && day.full.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    No free time that day: {day.full.map((f) => f.name).join(", ")}.
                  </p>
                )}
              </section>

              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={notify}
                  onCheckedChange={(v) => setNotify(v === true)}
                  className="mt-0.5"
                />
                <span>
                  Send the booking confirmation on WhatsApp{" "}
                  <span className="text-muted-foreground">
                    (not sent to a patient who did not agree)
                  </span>
                </span>
              </label>
              <Button onClick={book} disabled={pending || !who || !pick}>
                {pending ? <Loader2 className="animate-spin" /> : <CalendarPlus />}{" "}
                {pick ? `Book ${pick.label}` : "Book"}
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
