"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fromLocalInput } from "@/lib/enquiries/datetime";

import { createNewEnquiry, type ContactOption } from "./actions";
import { ClinicFields, type ClinicValues } from "./clinic-fields";
import { ContactPicker } from "./contact-picker";
import { CustomFieldInput } from "@/app/(app)/contacts/custom-field-input";
import { OptionSelect } from "./option-select";
import type { EnquiriesBootstrap } from "./types";

const AUTO = "__auto__";

export type NewEnquiryPreset = {
  pipelineId?: string | null;
  stageId?: string | null;
  contact?: ContactOption | null;
  title?: string;
  channelId?: string | null;
};

export function NewEnquiryDialog({
  open,
  onOpenChange,
  bootstrap,
  preset,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: EnquiriesBootstrap;
  preset: NewEnquiryPreset;
  onCreated: (id: string) => void;
}) {
  const live = bootstrap.pipelines.filter((p) => !p.archived);
  const defaultPipeline =
    (preset.pipelineId && live.find((p) => p.id === preset.pipelineId)) ||
    live.find((p) => p.is_default) ||
    live[0];
  const [pipelineId, setPipelineId] = React.useState(defaultPipeline?.id ?? "");
  const [stageId, setStageId] = React.useState<string | null>(preset.stageId ?? null);
  const [title, setTitle] = React.useState(preset.title ?? "");
  const [contact, setContact] = React.useState<ContactOption | null>(preset.contact ?? null);
  const [source, setSource] = React.useState<string | null>(null);
  const [channelId, setChannelId] = React.useState<string | null>(preset.channelId ?? null);
  const [assignee, setAssignee] = React.useState<string>(AUTO);
  const [estValue, setEstValue] = React.useState("");
  const [appt, setAppt] = React.useState("");
  const [clinic, setClinic] = React.useState<ClinicValues>({
    location_id: null,
    department_id: null,
    specialist_id: null,
    service_id: null,
  });
  const [custom, setCustom] = React.useState<Record<string, unknown>>({});
  const [pending, startTransition] = React.useTransition();

  // Reset whenever the dialog opens with a (possibly different) preset.
  React.useEffect(() => {
    if (!open) return;
    setPipelineId(defaultPipeline?.id ?? "");
    setStageId(preset.stageId ?? null);
    setTitle(preset.title ?? "");
    setContact(preset.contact ?? null);
    setSource(null);
    setChannelId(preset.channelId ?? null);
    setAssignee(AUTO);
    setEstValue("");
    setAppt("");
    setClinic({ location_id: null, department_id: null, specialist_id: null, service_id: null });
    setCustom({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pipeline = live.find((p) => p.id === pipelineId);
  const userOpts = bootstrap.users.map((u) => ({ value: u.id, label: u.label }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await createNewEnquiry({
        title: title.trim() || contact?.full_name || "New enquiry",
        pipeline_id: pipelineId,
        stage_id: stageId && pipeline?.stages.some((s) => s.id === stageId) ? stageId : null,
        contact_id: contact?.id ?? null,
        source,
        channel_id: channelId,
        auto_assign: assignee === AUTO,
        assignee_id: assignee === AUTO ? null : assignee === "" ? null : assignee,
        est_value: estValue.trim() || null,
        appt_date: fromLocalInput(appt, bootstrap.timezone),
        ...clinic,
        custom,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Enquiry created.");
      onOpenChange(false);
      onCreated(res.data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New enquiry</DialogTitle>
          <DialogDescription>
            It starts in the first stage unless you pick one. Assignment rules apply when set to
            automatic.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="ne-title">Title</Label>
            <Input
              id="ne-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="e.g. Knee consultation enquiry"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="ne-contact">Contact</Label>
            <ContactPicker
              id="ne-contact"
              value={contact}
              onChange={setContact}
              disabled={!bootstrap.can.contacts}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ne-pipeline">Pipeline</Label>
            <OptionSelect
              id="ne-pipeline"
              allowNone={false}
              value={pipelineId}
              options={live.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(v) => {
                setPipelineId(v ?? "");
                setStageId(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ne-stage">Stage</Label>
            <OptionSelect
              id="ne-stage"
              noneLabel="First stage"
              value={stageId}
              options={(pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
              onChange={setStageId}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ne-source">Source</Label>
            <OptionSelect
              id="ne-source"
              value={source}
              options={bootstrap.sources.map((s) => ({ value: s, label: s }))}
              onChange={setSource}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ne-channel">WhatsApp number</Label>
            <OptionSelect
              id="ne-channel"
              value={channelId}
              options={bootstrap.lookups.channels.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setChannelId}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ne-assignee">Assigned to</Label>
            <OptionSelect
              id="ne-assignee"
              allowNone={false}
              value={assignee}
              options={[
                { value: AUTO, label: "Automatic (by rules)" },
                { value: "", label: "Unassigned" },
                ...userOpts,
              ]}
              onChange={(v) => setAssignee(v ?? "")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ne-value">Estimated value</Label>
            <Input
              id="ne-value"
              inputMode="decimal"
              value={estValue}
              onChange={(e) => setEstValue(e.target.value)}
              placeholder="0"
            />
          </div>
          <ClinicFields
            idPrefix="ne"
            value={clinic}
            onChange={setClinic}
            lookups={bootstrap.lookups}
          />
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="ne-appt">Appointment date</Label>
            <Input
              id="ne-appt"
              type="datetime-local"
              value={appt}
              onChange={(e) => setAppt(e.target.value)}
            />
          </div>
          {bootstrap.customFields.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label htmlFor={`ne-custom-${f.key}`}>
                {f.label}
                {f.required && <span className="text-destructive"> *</span>}
              </Label>
              <CustomFieldInput
                id={`ne-custom-${f.key}`}
                def={f}
                value={custom[f.key]}
                onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
              />
            </div>
          ))}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !pipelineId}>
              {pending && <Loader2 className="animate-spin" />} Create enquiry
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
