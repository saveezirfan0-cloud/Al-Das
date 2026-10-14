"use client";

import { useState, useTransition } from "react";
import { Footprints, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

import { registerWalkIn } from "./actions";
import type { DeskOptions } from "./types";

/** The walk-in registration form: phone, name, language and the consent tick the clinic must collect. */
export function WalkInDialog({
  options,
  canBook,
  open,
  onOpenChange,
  onDone,
}: {
  options: DeskOptions;
  canBook: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: (contactId: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"en" | "ar" | "other">("en");
  const [consent, setConsent] = useState(false);
  const [promo, setPromo] = useState(false);
  const [onBoard, setOnBoard] = useState(false);
  const [locationId, setLocationId] = useState(
    options.currentLocationId ?? options.locations[0]?.id ?? "",
  );
  const [specialistId, setSpecialistId] = useState("");
  const [serviceId, setServiceId] = useState("");

  const doctor = options.specialists.find((s) => s.id === specialistId);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await registerWalkIn({
        phone,
        name,
        language,
        consent_contact: consent as true,
        consent_promotions: promo,
        add_to_today: onBoard,
        locationId: onBoard ? locationId || undefined : undefined,
        specialistId: onBoard ? specialistId || undefined : undefined,
        serviceId: onBoard ? serviceId || undefined : undefined,
      });
      if (r.ok && r.data) {
        toast.success(r.message ?? "Registered.");
        setPhone("");
        setName("");
        setConsent(false);
        setPromo(false);
        setOnBoard(false);
        onOpenChange(false);
        onDone?.(r.data.contactId);
      } else if (!r.ok) toast.error(r.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Footprints /> Walk-in{" "}
          <kbd className="bg-primary-foreground/20 rounded px-1 font-mono text-[10px]">N</kbd>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Register a walk-in</DialogTitle>
            <DialogDescription>
              Takes ten seconds. An existing patient with the same number is found, not duplicated.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="wi-phone">Mobile number</Label>
            <Input
              id="wi-phone"
              inputMode="tel"
              autoComplete="off"
              placeholder="050 123 4567 or +44 …"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="wi-name">Full name</Label>
            <Input
              id="wi-name"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1">
            <Label>Language for messages</Label>
            <Select value={language} onValueChange={(v) => setLanguage(v as typeof language)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="ar">Arabic</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => setConsent(v === true)}
              className="mt-0.5"
            />
            <span>
              The patient agrees to be contacted on WhatsApp about their appointments and care.{" "}
              <span className="text-muted-foreground">(required)</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={promo}
              onCheckedChange={(v) => setPromo(v === true)}
              className="mt-0.5"
            />
            <span>
              The patient also agrees to receive offers and news.{" "}
              <span className="text-muted-foreground">(optional, separate)</span>
            </span>
          </label>
          {canBook && (
            <div className="grid gap-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={onBoard} onCheckedChange={(v) => setOnBoard(v === true)} />
                Put on today&apos;s board now (arrived)
              </label>
              {onBoard && (
                <div className="grid gap-2">
                  <Select value={locationId} onValueChange={setLocationId}>
                    <SelectTrigger className="w-full" aria-label="Place">
                      <SelectValue placeholder="Place" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={specialistId}
                    onValueChange={(v) => {
                      setSpecialistId(v);
                      setServiceId("");
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Doctor">
                      <SelectValue placeholder="Doctor" />
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
                  <Select value={serviceId} onValueChange={setServiceId} disabled={!doctor}>
                    <SelectTrigger className="w-full" aria-label="Service">
                      <SelectValue placeholder="Service" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.services
                        .filter((s) => doctor?.service_ids.includes(s.id))
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending || !consent}>
              {pending && <Loader2 className="animate-spin" />} Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
