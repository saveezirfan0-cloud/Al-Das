"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, MessageSquare, Save } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { coerceCustomObject } from "@/lib/contacts/custom-values";
import type { EnquiryRow } from "@/lib/enquiries/types";
import type { EnquiryStatus } from "@/lib/enquiries/status";
import { formatPhone } from "@/lib/phone";

import { CustomFieldInput } from "../contacts/custom-field-input";
import { listContactConversations } from "../inbox/actions";
import {
  getEnquiryDetail,
  moveStageAction,
  moveToPipelineAction,
  setStatusAction,
  updateEnquiryAction,
  type EnquiryDetail,
} from "./actions";
import { StageDot, StatusBadge } from "./badges";
import { ago, formatWhen, fromLocalInput, slaChip, toLocalInput } from "./format";
import { StatusDialog } from "./status-dialog";
import type { EnquiriesBootstrap } from "./types";

const NONE = "__none";

type Form = {
  title: string;
  source: string;
  channel_id: string;
  location_id: string;
  department_id: string;
  specialist_id: string;
  service_id: string;
  appointment_at: string;
  assignee_id: string;
  est_value: string;
  custom: Record<string, unknown>;
};

function toForm(r: EnquiryRow, tz: string): Form {
  return {
    title: r.title,
    source: r.source ?? "",
    channel_id: r.channel_id ?? NONE,
    location_id: r.location_id ?? NONE,
    department_id: r.department_id ?? NONE,
    specialist_id: r.specialist_id ?? NONE,
    service_id: r.service_id ?? NONE,
    appointment_at: toLocalInput(r.appointment_at, tz),
    assignee_id: r.assignee_id ?? NONE,
    est_value: r.est_value === null ? "" : String(r.est_value),
    custom: r.custom,
  };
}

type Conversation = {
  id: string;
  status: string;
  channel: string;
  last_message_at: string | null;
  preview: string | null;
  unread: number;
};

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function RefSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>—</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function EnquiryDrawer({
  enquiryId,
  bootstrap,
  onClose,
  onChanged,
}: {
  enquiryId: string | null;
  bootstrap: EnquiriesBootstrap;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<EnquiryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pending, start] = useTransition();
  const [statusTarget, setStatusTarget] = useState<EnquiryStatus | null>(null);
  const [movePipeline, setMovePipeline] = useState("");
  const [moveStage, setMoveStage] = useState("");
  const [conversations, setConversations] = useState<Conversation[] | null>(null);

  const canManage = bootstrap.can.manage;
  const tz = bootstrap.timezone;

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      const r = await getEnquiryDetail(id);
      setLoading(false);
      if (!r.ok) {
        setError(r.error);
        setDetail(null);
        return;
      }
      setError(null);
      setDetail(r);
      setForm(toForm(r.row, tz));
      setMovePipeline("");
      setMoveStage("");
    },
    [tz],
  );

  useEffect(() => {
    setDetail(null);
    setForm(null);
    setConversations(null);
    setError(null);
    if (enquiryId) void load(enquiryId);
  }, [enquiryId, load]);

  const row = detail?.row ?? null;
  const pipeline = bootstrap.pipelines.find((p) => p.id === row?.pipeline_id);
  const customDefs = bootstrap.customFields;

  const dirty = useMemo(() => {
    if (!row || !form) return false;
    return JSON.stringify(toForm(row, tz)) !== JSON.stringify(form);
  }, [row, form, tz]);

  function refresh() {
    if (enquiryId) void load(enquiryId);
    onChanged();
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Something went wrong.");
        return;
      }
      if (success) toast.success(success);
      refresh();
    });
  }

  function save() {
    if (!row || !form) return;
    const est = form.est_value.trim() === "" ? null : Number(form.est_value);
    if (est !== null && (!Number.isFinite(est) || est < 0)) {
      toast.error("Estimated value must be a positive number.");
      return;
    }
    const custom = coerceCustomObject(customDefs, form.custom);
    if (!custom.ok) {
      toast.error(Object.values(custom.errors)[0] ?? "Check the custom fields.");
      return;
    }
    const nullable = (v: string) => (v === NONE ? null : v);
    run(
      () =>
        updateEnquiryAction(row.id, {
          title: form.title.trim(),
          source: form.source.trim() || null,
          channel_id: nullable(form.channel_id),
          location_id: nullable(form.location_id),
          department_id: nullable(form.department_id),
          specialist_id: nullable(form.specialist_id),
          service_id: nullable(form.service_id),
          appointment_at: fromLocalInput(form.appointment_at, tz),
          assignee_id: nullable(form.assignee_id),
          est_value: est,
          custom: form.custom,
        }),
      "Saved.",
    );
  }

  async function loadConversations() {
    if (!row?.contact_id || conversations) return;
    const r = await listContactConversations(row.contact_id);
    setConversations(r.ok ? r.data : []);
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));
  const sla = row ? slaChip(row, bootstrap.slaHours) : null;
  const targetPipeline = bootstrap.pipelines.find((p) => p.id === movePipeline);

  return (
    <Sheet open={enquiryId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b pe-12">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {row ? `#${row.number} ${row.patient || row.title || "Enquiry"}` : "Enquiry"}
            {row && <StatusBadge status={row.status} />}
          </SheetTitle>
          <SheetDescription>
            {row ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{row.pipeline_name}</span>
                <span className="flex items-center gap-1.5">
                  <StageDot color={row.stage_color} /> {row.stage_name}
                </span>
                {row.phone && <span className="tabular-nums">{formatPhone(row.phone)}</span>}
                {sla && row.status === "open" && (
                  <span className={sla.breached ? "font-medium text-red-600" : ""}>
                    SLA: {sla.text}
                  </span>
                )}
              </span>
            ) : (
              "Loading…"
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && !row && (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {error && <p className="text-destructive p-4 text-sm">{error}</p>}
          {row && form && (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Stage">
                  <Select
                    value={row.stage_id}
                    disabled={!canManage || pending}
                    onValueChange={(stageId) => run(() => moveStageAction(row.id, stageId))}
                  >
                    <SelectTrigger className="w-48" aria-label="Stage">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(pipeline?.stages ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {canManage && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Status">
                    {row.status !== "open" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          run(() => setStatusAction(row.id, { status: "open" }), "Reopened.")
                        }
                      >
                        Reopen
                      </Button>
                    )}
                    {row.status !== "won" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          run(() => setStatusAction(row.id, { status: "won" }), "Marked won.")
                        }
                      >
                        Won
                      </Button>
                    )}
                    {row.status !== "lost" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setStatusTarget("lost")}
                      >
                        Lost…
                      </Button>
                    )}
                    {row.status !== "disqualified" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setStatusTarget("disqualified")}
                      >
                        Disqualify…
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {row.lost_reason && (
                <p className="bg-muted rounded-md px-3 py-2 text-sm">
                  <span className="font-medium">
                    {row.status === "lost" ? "Lost" : "Disqualified"}:
                  </span>{" "}
                  {row.lost_reason}
                </p>
              )}

              <Tabs
                defaultValue="details"
                onValueChange={(v) => {
                  if (v === "inbox") void loadConversations();
                }}
              >
                <TabsList>
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="inbox">Inbox</TabsTrigger>
                </TabsList>

                <TabsContent value="details" className="flex flex-col gap-4 pt-3">
                  <Field label="Title" htmlFor="enq-d-title">
                    <Input
                      id="enq-d-title"
                      value={form.title}
                      maxLength={200}
                      disabled={!canManage}
                      onChange={(e) => set("title", e.target.value)}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <RefSelect
                      label="Assigned to"
                      value={form.assignee_id}
                      onChange={(v) => set("assignee_id", v)}
                      options={bootstrap.users.map((u) => ({ id: u.id, name: u.label }))}
                      disabled={!canManage}
                    />
                    <Field label="Source" htmlFor="enq-d-source">
                      <Input
                        id="enq-d-source"
                        list="enq-d-sources"
                        value={form.source}
                        maxLength={80}
                        disabled={!canManage}
                        onChange={(e) => set("source", e.target.value)}
                      />
                      <datalist id="enq-d-sources">
                        {bootstrap.sources.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </Field>
                    <RefSelect
                      label="Channel"
                      value={form.channel_id}
                      onChange={(v) => set("channel_id", v)}
                      options={bootstrap.channels}
                      disabled={!canManage}
                    />
                    <Field label="Estimated value" htmlFor="enq-d-value">
                      <Input
                        id="enq-d-value"
                        inputMode="decimal"
                        value={form.est_value}
                        disabled={!canManage}
                        onChange={(e) => set("est_value", e.target.value)}
                      />
                    </Field>
                    <RefSelect
                      label="Location"
                      value={form.location_id}
                      onChange={(v) => set("location_id", v)}
                      options={bootstrap.locations}
                      disabled={!canManage}
                    />
                    <RefSelect
                      label="Department"
                      value={form.department_id}
                      onChange={(v) => set("department_id", v)}
                      options={bootstrap.departments}
                      disabled={!canManage}
                    />
                    <RefSelect
                      label="Specialist"
                      value={form.specialist_id}
                      onChange={(v) => set("specialist_id", v)}
                      options={bootstrap.specialists}
                      disabled={!canManage}
                    />
                    <RefSelect
                      label="Service"
                      value={form.service_id}
                      onChange={(v) => set("service_id", v)}
                      options={bootstrap.services}
                      disabled={!canManage}
                    />
                    <Field label={`Appointment (${tz})`} htmlFor="enq-d-appt">
                      <Input
                        id="enq-d-appt"
                        type="datetime-local"
                        value={form.appointment_at}
                        disabled={!canManage}
                        onChange={(e) => set("appointment_at", e.target.value)}
                      />
                    </Field>
                  </div>

                  {customDefs.length > 0 && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {customDefs.map((def) => (
                        <Field key={def.key} label={def.label} htmlFor={`enq-c-${def.key}`}>
                          <CustomFieldInput
                            id={`enq-c-${def.key}`}
                            def={def}
                            value={form.custom[def.key]}
                            onChange={(v) => set("custom", { ...form.custom, [def.key]: v })}
                          />
                        </Field>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {canManage && (
                      <Button disabled={!dirty || pending} onClick={save}>
                        {pending ? <Loader2 className="animate-spin" /> : <Save />} Save changes
                      </Button>
                    )}
                    {row.contact_id && bootstrap.can.contacts && (
                      <Button variant="outline" asChild>
                        <Link href={`/contacts?contact=${row.contact_id}`}>
                          <ExternalLink /> Open patient
                        </Link>
                      </Button>
                    )}
                  </div>

                  {canManage && (
                    <section
                      className="flex flex-col gap-2 rounded-md border p-3"
                      aria-label="Move to another pipeline"
                    >
                      <h3 className="text-sm font-medium">Move to another pipeline</h3>
                      <div className="flex flex-wrap items-end gap-2">
                        <Select
                          value={movePipeline}
                          onValueChange={(v) => {
                            setMovePipeline(v);
                            setMoveStage("");
                          }}
                        >
                          <SelectTrigger className="w-44" aria-label="Target pipeline">
                            <SelectValue placeholder="Pipeline…" />
                          </SelectTrigger>
                          <SelectContent>
                            {bootstrap.pipelines
                              .filter((p) => !p.archived && p.id !== row.pipeline_id)
                              .map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={moveStage || targetPipeline?.stages[0]?.id || ""}
                          onValueChange={setMoveStage}
                          disabled={!targetPipeline}
                        >
                          <SelectTrigger className="w-40" aria-label="Target stage">
                            <SelectValue placeholder="Stage…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(targetPipeline?.stages ?? []).map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          disabled={!targetPipeline || pending}
                          onClick={() =>
                            run(
                              () =>
                                moveToPipelineAction(
                                  row.id,
                                  movePipeline,
                                  moveStage || targetPipeline?.stages[0]?.id,
                                ),
                              "Moved.",
                            )
                          }
                        >
                          Move
                        </Button>
                      </div>
                    </section>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Created {formatWhen(row.created_at, tz)}
                    {row.created_by_name ? ` by ${row.created_by_name}` : ""}
                    {row.closed_at ? ` · closed ${formatWhen(row.closed_at, tz)}` : ""}
                  </p>
                </TabsContent>

                <TabsContent value="timeline" className="pt-3">
                  {detail && detail.timeline.length === 0 && (
                    <p className="text-muted-foreground text-sm">No activity yet.</p>
                  )}
                  <ol className="flex flex-col gap-3">
                    {detail?.timeline.map((e) => (
                      <li key={e.id} className="border-s-2 ps-3 text-sm">
                        <div className="font-medium">{eventLabel(e.type)}</div>
                        {e.detail && <div className="text-muted-foreground">{e.detail}</div>}
                        <div className="text-muted-foreground text-xs" title={formatWhen(e.at, tz)}>
                          {e.actor ? `${e.actor} · ` : ""}
                          {ago(e.at)}
                        </div>
                      </li>
                    ))}
                  </ol>
                </TabsContent>

                <TabsContent value="inbox" className="pt-3">
                  {!row.contact_id && (
                    <p className="text-muted-foreground text-sm">
                      This enquiry has no linked patient.
                    </p>
                  )}
                  {row.contact_id && conversations === null && (
                    <p className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading conversations…
                    </p>
                  )}
                  {conversations && conversations.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      No conversations you can see for this patient.
                    </p>
                  )}
                  <ul className="flex flex-col gap-2">
                    {(conversations ?? []).map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/inbox?c=${c.id}`}
                          className="hover:bg-accent flex items-start gap-2 rounded-md border p-2.5 text-sm"
                        >
                          <MessageSquare className="mt-0.5 size-4 shrink-0" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-medium">{c.channel}</span>
                              <span className="text-muted-foreground text-xs capitalize">
                                {c.status}
                                {c.unread > 0 ? ` · ${c.unread} unread` : ""}
                              </span>
                            </span>
                            {c.preview && (
                              <span className="text-muted-foreground block truncate">
                                {c.preview}
                              </span>
                            )}
                            <span className="text-muted-foreground text-xs">
                              {ago(c.last_message_at)}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>

        <StatusDialog
          key={statusTarget ?? "none"}
          status={statusTarget}
          pending={pending}
          onCancel={() => setStatusTarget(null)}
          onConfirm={(status, reason) => {
            if (!row) return;
            setStatusTarget(null);
            run(
              () => setStatusAction(row.id, { status, reason }),
              status === "lost" ? "Marked lost." : "Disqualified.",
            );
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

const EVENT_LABELS: Record<string, string> = {
  "enquiry.created": "Enquiry created",
  "enquiry.updated": "Details updated",
  "enquiry.stage_changed": "Stage changed",
  "enquiry.pipeline_changed": "Moved to another pipeline",
  "enquiry.status_changed": "Status changed",
  "enquiry.assigned": "Assignment changed",
  "task.created": "Task added",
  "task.completed": "Task completed",
};

function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}
