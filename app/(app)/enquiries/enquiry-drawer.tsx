"use client";

import * as React from "react";
import { ArrowRightLeft, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ContactConversations } from "@/app/(app)/contacts/contact-conversations";
import { CustomFieldInput } from "@/app/(app)/contacts/custom-field-input";
import { Timeline } from "@/components/timeline/timeline";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ENQUIRY_STATUSES, STATUS_LABELS, type EnquiryStatus } from "@/lib/enquiries/constants";
import { fromLocalInput, toLocalInput } from "@/lib/enquiries/datetime";

import {
  addEnquiryNote,
  changePipeline,
  changeStage,
  changeStatus,
  getEnquiry,
  removeEnquiries,
  updateEnquiryDetails,
  type ContactOption,
  type EnquiryDetail,
} from "./actions";
import { ClinicFields, type ClinicValues } from "./clinic-fields";
import { ContactPicker } from "./contact-picker";
import { SlaBadge, StatusBadge } from "./enquiries-grid";
import { OptionSelect } from "./option-select";
import { StatusReasonDialog } from "./status-dialog";
import type { EnquiriesBootstrap } from "./types";

type Form = {
  title: string;
  contact: ContactOption | null;
  channel_id: string | null;
  source: string | null;
  assignee_id: string | null;
  est_value: string;
  appt: string;
  clinic: ClinicValues;
  custom: Record<string, unknown>;
};

function toForm(d: EnquiryDetail, tz: string): Form {
  const e = d.enquiry;
  return {
    title: e.title,
    contact: e.contact
      ? { id: e.contact.id, full_name: e.contact.full_name, phone_e164: e.contact.phone_e164 }
      : null,
    channel_id: e.channel_id,
    source: e.source,
    assignee_id: e.assignee_id,
    est_value: e.est_value === null ? "" : String(e.est_value),
    appt: toLocalInput(e.appt_date, tz),
    clinic: {
      location_id: e.location_id,
      department_id: e.department_id,
      specialist_id: e.specialist_id,
      service_id: e.service_id,
    },
    custom: e.custom,
  };
}

export function EnquiryDrawer({
  enquiryId,
  onClose,
  bootstrap,
  onChanged,
  tasksTab,
}: {
  enquiryId: string | null;
  onClose: () => void;
  bootstrap: EnquiriesBootstrap;
  onChanged: () => void;
  /** Rendered in the "Tasks" tab (Phase 5 tasks UI). */
  tasksTab?: (detail: EnquiryDetail, reload: () => Promise<void>) => React.ReactNode;
}) {
  const [detail, setDetail] = React.useState<EnquiryDetail | null>(null);
  const [form, setForm] = React.useState<Form | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [note, setNote] = React.useState("");
  const [reasonFor, setReasonFor] = React.useState<EnquiryStatus | null>(null);
  const [movePipelineId, setMovePipelineId] = React.useState<string | null>(null);

  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  const load = React.useCallback(async () => {
    if (!enquiryId) return;
    setLoading(true);
    const res = await getEnquiry(enquiryId);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      onCloseRef.current();
      return;
    }
    setDetail(res.data);
    setForm(toForm(res.data, bootstrap.timezone));
    setDirty(false);
  }, [enquiryId, bootstrap.timezone]);

  React.useEffect(() => {
    if (enquiryId) void load();
    else {
      setDetail(null);
      setForm(null);
    }
  }, [enquiryId, load]);

  const canManage = bootstrap.can.manage;
  const e = detail?.enquiry;
  const pipeline = e ? bootstrap.pipelines.find((p) => p.id === e.pipeline_id) : undefined;

  function patch(p: Partial<Form>) {
    setForm((f) => (f ? { ...f, ...p } : f));
    setDirty(true);
  }

  function run(
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    after?: () => void,
  ) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.message) toast.success(res.message);
      await load();
      onChanged();
      after?.();
    });
  }

  function save() {
    if (!detail || !form) return;
    run(() =>
      updateEnquiryDetails(detail.enquiry.id, {
        title: form.title,
        contact_id: form.contact?.id ?? null,
        channel_id: form.channel_id,
        source: form.source,
        assignee_id: form.assignee_id,
        est_value: form.est_value.trim() || null,
        appt_date: fromLocalInput(form.appt, bootstrap.timezone),
        ...form.clinic,
        custom: form.custom,
      }),
    );
  }

  const otherPipelines = bootstrap.pipelines.filter((p) => !p.archived && p.id !== e?.pipeline_id);

  return (
    <Sheet open={!!enquiryId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-5xl">
        {loading && !detail ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : e && form ? (
          <>
            <SheetHeader className="border-b">
              <div className="flex flex-wrap items-center gap-3 pr-8">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate">
                    <span className="text-muted-foreground font-normal tabular-nums">
                      #{e.number}
                    </span>{" "}
                    {e.title}
                  </SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-2">
                    <span>{pipeline?.name}</span>
                    <StatusBadge status={e.status} />
                    <SlaBadge row={e} />
                    {e.lost_reason && <span className="text-xs">Reason: {e.lost_reason}</span>}
                  </SheetDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-44">
                    <OptionSelect
                      allowNone={false}
                      disabled={!canManage || pending}
                      value={e.stage_id}
                      options={(pipeline?.stages ?? []).map((s) => ({
                        value: s.id,
                        label: s.name,
                      }))}
                      onChange={(v) => v && v !== e.stage_id && run(() => changeStage(e.id, v))}
                    />
                  </div>
                  <div className="w-40">
                    <OptionSelect
                      allowNone={false}
                      disabled={!canManage || pending}
                      value={e.status}
                      options={ENQUIRY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
                      onChange={(v) => {
                        if (!v || v === e.status) return;
                        if (v === "lost" || v === "disqualified") setReasonFor(v);
                        else run(() => changeStatus(e.id, { status: v }));
                      }}
                    />
                  </div>
                  {bootstrap.can.delete && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete enquiry"
                      className="text-destructive"
                      onClick={() => {
                        if (
                          confirm(
                            "Delete this enquiry? It disappears from lists and boards; the audit log keeps a record.",
                          )
                        )
                          run(() => removeEnquiries([e.id]), onClose);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
            </SheetHeader>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="ed-title">Title</Label>
                    <Input
                      id="ed-title"
                      value={form.title}
                      disabled={!canManage}
                      maxLength={200}
                      onChange={(ev) => patch({ title: ev.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="ed-contact">Contact</Label>
                    <ContactPicker
                      id="ed-contact"
                      value={form.contact}
                      disabled={!canManage || !bootstrap.can.contacts}
                      onChange={(c) => patch({ contact: c })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ed-assignee">Assigned to</Label>
                    <OptionSelect
                      id="ed-assignee"
                      noneLabel="Unassigned"
                      disabled={!canManage}
                      value={form.assignee_id}
                      options={bootstrap.users.map((u) => ({ value: u.id, label: u.label }))}
                      onChange={(v) => patch({ assignee_id: v })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ed-value">Estimated value</Label>
                    <Input
                      id="ed-value"
                      inputMode="decimal"
                      disabled={!canManage}
                      value={form.est_value}
                      onChange={(ev) => patch({ est_value: ev.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ed-source">Source</Label>
                    <OptionSelect
                      id="ed-source"
                      disabled={!canManage}
                      value={form.source}
                      options={
                        bootstrap.sources.includes(form.source ?? "") || !form.source
                          ? bootstrap.sources.map((s) => ({ value: s, label: s }))
                          : [...bootstrap.sources, form.source].map((s) => ({ value: s, label: s }))
                      }
                      onChange={(v) => patch({ source: v })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ed-channel">WhatsApp number</Label>
                    <OptionSelect
                      id="ed-channel"
                      disabled={!canManage}
                      value={form.channel_id}
                      options={bootstrap.lookups.channels.map((c) => ({
                        value: c.id,
                        label: c.name,
                      }))}
                      onChange={(v) => patch({ channel_id: v })}
                    />
                  </div>
                  <ClinicFields
                    idPrefix="ed"
                    lookups={bootstrap.lookups}
                    disabled={!canManage}
                    value={form.clinic}
                    onChange={(clinic) => patch({ clinic })}
                  />
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="ed-appt">Appointment date</Label>
                    <Input
                      id="ed-appt"
                      type="datetime-local"
                      disabled={!canManage}
                      value={form.appt}
                      onChange={(ev) => patch({ appt: ev.target.value })}
                    />
                  </div>
                  {bootstrap.customFields.length > 0 && (
                    <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
                      <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase sm:col-span-2">
                        Custom fields
                      </h4>
                      {bootstrap.customFields.map((f) => (
                        <div key={f.key} className="grid gap-1.5">
                          <Label htmlFor={`ed-custom-${f.key}`}>
                            {f.label}
                            {f.required && <span className="text-destructive"> *</span>}
                          </Label>
                          <CustomFieldInput
                            id={`ed-custom-${f.key}`}
                            def={f}
                            value={form.custom[f.key]}
                            onChange={(v) => patch({ custom: { ...form.custom, [f.key]: v } })}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {canManage && otherPipelines.length > 0 && (
                  <section className="flex flex-col gap-2 border-t pt-3">
                    <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                      Move to another pipeline
                    </h3>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <OptionSelect
                          allowNone={false}
                          placeholder="Choose a pipeline"
                          value={movePipelineId}
                          options={otherPipelines.map((p) => ({ value: p.id, label: p.name }))}
                          onChange={setMovePipelineId}
                        />
                      </div>
                      <Button
                        variant="outline"
                        disabled={!movePipelineId || pending}
                        onClick={() =>
                          movePipelineId &&
                          run(
                            () => changePipeline(e.id, movePipelineId),
                            () => setMovePipelineId(null),
                          )
                        }
                      >
                        <ArrowRightLeft /> Move
                      </Button>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      It lands in the first stage of the new pipeline.
                    </p>
                  </section>
                )}

                {canManage && (
                  <div className="bg-background sticky bottom-0 -mx-4 mt-auto flex items-center justify-end gap-2 border-t px-4 py-3">
                    {dirty && (
                      <span className="text-muted-foreground mr-auto text-xs">Unsaved changes</span>
                    )}
                    <Button
                      variant="ghost"
                      disabled={!dirty || pending}
                      onClick={() =>
                        detail && (setForm(toForm(detail, bootstrap.timezone)), setDirty(false))
                      }
                    >
                      Discard
                    </Button>
                    <Button disabled={!dirty || pending || !form.title.trim()} onClick={save}>
                      {pending ? <Loader2 className="animate-spin" /> : <Save />} Save
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-col p-4">
                <Tabs defaultValue="timeline" className="flex min-h-0 flex-1 flex-col">
                  <TabsList>
                    <TabsTrigger value="timeline">Timeline</TabsTrigger>
                    <TabsTrigger value="inbox">Inbox</TabsTrigger>
                    {tasksTab && bootstrap.can.tasks && (
                      <TabsTrigger value="tasks">Tasks</TabsTrigger>
                    )}
                  </TabsList>
                  <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
                    {canManage && (
                      <form
                        className="flex flex-col gap-2"
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          if (!note.trim()) return;
                          run(
                            () => addEnquiryNote(e.id, note),
                            () => setNote(""),
                          );
                        }}
                      >
                        <Textarea
                          value={note}
                          onChange={(ev) => setNote(ev.target.value)}
                          rows={2}
                          placeholder="Add a note…"
                          aria-label="New note"
                          maxLength={4000}
                        />
                        <div className="flex justify-end">
                          <Button
                            type="submit"
                            size="sm"
                            variant="outline"
                            disabled={pending || !note.trim()}
                          >
                            Add note
                          </Button>
                        </div>
                      </form>
                    )}
                    <Timeline events={detail.timeline} timezone={bootstrap.timezone} />
                  </TabsContent>
                  <TabsContent value="inbox" className="pt-3">
                    {e.contact ? (
                      <ContactConversations contactId={e.contact.id} />
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        Link a contact to see their WhatsApp conversations.
                      </p>
                    )}
                  </TabsContent>
                  {tasksTab && bootstrap.can.tasks && (
                    <TabsContent value="tasks" className="min-h-0 flex-1 overflow-y-auto pt-3">
                      {tasksTab(detail, load)}
                    </TabsContent>
                  )}
                </Tabs>
              </div>
            </div>

            <StatusReasonDialog
              open={!!reasonFor}
              status={reasonFor}
              pending={pending}
              onCancel={() => setReasonFor(null)}
              onConfirm={(reason) =>
                reasonFor &&
                run(
                  () => changeStatus(e.id, { status: reasonFor, reason }),
                  () => setReasonFor(null),
                )
              }
            />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
