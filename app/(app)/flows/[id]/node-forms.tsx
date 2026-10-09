"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { emptyGroup, type Filter } from "@/lib/filters/ast";
import { NODE_META, type NodeType } from "@/lib/flow-engine/types";

import {
  ConditionsEditor,
  KeyValueEditor,
  NumberField,
  OptionsEditor,
  ScheduleEditor,
  SelectField,
  TextField,
} from "./fields";
import type { BuilderLookups } from "./lookups";

type Data = Record<string, unknown>;
type Props = {
  type: NodeType;
  data: Data;
  onChange: (data: Data) => void;
  lookups: BuilderLookups;
};

const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const n = (v: unknown) => (typeof v === "number" ? v : undefined);
const rec = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const CONTACT_FIELDS = [
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "email", label: "E-mail" },
  { value: "gender", label: "Gender (female / male / other / unknown)" },
  { value: "language", label: "Language" },
  { value: "label", label: "Label" },
  { value: "nationality", label: "Nationality" },
];

export function NodeForm({ type, data, onChange, lookups }: Props) {
  const set = (patch: Data) => onChange({ ...data, ...patch });
  const opt = (rows: Array<{ id: string; name: string }>) =>
    rows.map((r) => ({ value: r.id, label: r.name }));

  switch (type) {
    case "trigger":
      return (
        <p className="text-muted-foreground text-sm">
          The flow starts here. Change what starts it with <strong>Trigger settings</strong> at the
          top.
        </p>
      );

    case "message":
      return (
        <TextField
          label="Message"
          value={s(data.text)}
          onChange={(v) => set({ text: v })}
          multiline
          max={4096}
          interpolate
          help="Plain text. Free-form messages only reach patients inside the 24-hour window; use a Template step to reach anyone."
        />
      );

    case "question": {
      const kind = s(data.kind, "text") as "text" | "buttons" | "list";
      return (
        <div className="space-y-3">
          <TextField
            label="Question"
            value={s(data.text)}
            onChange={(v) => set({ text: v })}
            multiline
            max={1024}
            interpolate
          />
          <SelectField
            label="Answer type"
            value={kind}
            onChange={(v) => set({ kind: v, options: v === "text" ? [] : arr(data.options) })}
            options={[
              { value: "text", label: "Free text" },
              { value: "buttons", label: "Buttons (up to 3)" },
              { value: "list", label: "List (up to 10 rows)" },
            ]}
          />
          {kind !== "text" ? (
            <OptionsEditor
              kind={kind}
              options={arr(data.options)}
              onChange={(o) => set({ options: o })}
            />
          ) : null}
          {kind === "list" ? (
            <TextField
              label="List button label"
              value={s(data.listButtonLabel)}
              max={20}
              placeholder="Choose"
              onChange={(v) => set({ listButtonLabel: v || undefined })}
            />
          ) : null}
          <TextField
            label="Save the answer to variable"
            value={s(data.variable)}
            max={40}
            mono
            onChange={(v) => set({ variable: v })}
            help={`Use it later as {vars.${s(data.variable) || "name"}}${kind !== "text" ? `, and {vars.${s(data.variable) || "name"}_id} for the option id` : ""}.`}
          />
          <NumberField
            label="Give up after (minutes)"
            value={n(data.timeoutMinutes)}
            min={1}
            onChange={(v) => set({ timeoutMinutes: v })}
            help="Then the flow follows the “fallback” exit. Leave empty to wait indefinitely."
          />
        </div>
      );
    }

    case "quick_reply":
      return (
        <div className="space-y-3">
          <TextField
            label="Message"
            value={s(data.text)}
            onChange={(v) => set({ text: v })}
            multiline
            max={1024}
            interpolate
          />
          <OptionsEditor
            kind="buttons"
            options={arr(data.options)}
            onChange={(o) => set({ options: o })}
          />
          <NumberField
            label="Give up after (minutes)"
            value={n(data.timeoutMinutes)}
            min={1}
            onChange={(v) => set({ timeoutMinutes: v })}
          />
          <p className="text-muted-foreground text-xs">
            Each button gets its own exit on the canvas.
          </p>
        </div>
      );

    case "template": {
      const t = lookups.templates.find((x) => x.id === data.templateId);
      return (
        <div className="space-y-3">
          <SelectField
            label="Template"
            value={s(data.templateId) || undefined}
            onChange={(v) => set({ templateId: v })}
            options={lookups.templates.map((x) => ({
              value: x.id,
              label: `${x.name} (${x.language})${x.status === "APPROVED" ? "" : ` · ${x.status.toLowerCase()}`}`,
            }))}
          />
          {t && t.status !== "APPROVED" ? (
            <Alert>
              <AlertDescription>
                This template is {t.status.toLowerCase()}. It cannot be sent until it is approved.
              </AlertDescription>
            </Alert>
          ) : null}
          <KeyValueEditor
            label="Variable values"
            keyLabel="Variable"
            keyOptions={["body.1", "body.2", "body.3", "body.4", "header.1"]}
            value={rec(data.values)}
            onChange={(v) => set({ values: v })}
          />
          <p className="text-muted-foreground text-xs">
            Variables are named like <code>body.1</code>. Marketing templates are never sent to
            people who have not opted in.
          </p>
        </div>
      );
    }

    case "branch":
      return (
        <div className="space-y-2">
          <ConditionsEditor
            value={data.conditions as Filter | undefined}
            onChange={(f) => set({ conditions: f ?? { include: emptyGroup("and") } })}
            title="If…"
          />
          <p className="text-muted-foreground text-xs">
            Matches follow the “true” exit, everything else “false”.
          </p>
        </div>
      );

    case "wait":
      return (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Wait for"
            value={n(data.amount)}
            min={1}
            onChange={(v) => set({ amount: v ?? 1 })}
          />
          <SelectField
            label="Unit"
            value={s(data.unit, "minutes")}
            onChange={(v) => set({ unit: v })}
            options={[
              { value: "seconds", label: "Seconds" },
              { value: "minutes", label: "Minutes" },
              { value: "hours", label: "Hours" },
              { value: "days", label: "Days" },
            ]}
          />
          <p className="text-muted-foreground col-span-2 text-xs">
            Up to 30 days. The run is parked, not held in memory, so long waits are fine.
          </p>
        </div>
      );

    case "office_hours":
      return (
        <div className="space-y-3">
          <TextField
            label="Time zone"
            value={s(data.timezone)}
            placeholder="Workspace time zone"
            onChange={(v) => set({ timezone: v || undefined })}
            help="IANA name, e.g. Asia/Dubai. Empty uses the workspace time zone."
          />
          <ScheduleEditor value={(data.days as never) ?? {}} onChange={(d) => set({ days: d })} />
        </div>
      );

    case "run_flow":
      return (
        <SelectField
          label="Hand over to"
          value={s(data.flowId) || undefined}
          onChange={(v) => set({ flowId: v })}
          options={opt(lookups.flows)}
          help="This flow ends and the other one continues with the same patient and variables."
        />
      );

    case "end_flow":
      return <p className="text-muted-foreground text-sm">Stops the flow here. Nothing is sent.</p>;

    case "assign_to":
      return (
        <div className="space-y-3">
          <SelectField
            label="Person"
            value={s(data.userId) || undefined}
            allowNone
            noneLabel="No one in particular"
            onChange={(v) => set({ userId: v })}
            options={opt(lookups.people)}
          />
          <SelectField
            label="Team"
            value={s(data.teamId) || undefined}
            allowNone
            noneLabel="No team"
            onChange={(v) => set({ teamId: v })}
            options={opt(lookups.teams)}
          />
        </div>
      );

    case "close_conversation":
      return (
        <p className="text-muted-foreground text-sm">
          Closes the conversation. The bot run for it ends with the next step.
        </p>
      );

    case "add_comment":
      return (
        <TextField
          label="Internal comment"
          value={s(data.text)}
          onChange={(v) => set({ text: v })}
          multiline
          max={2000}
          interpolate
          help="Only your team sees comments; they are never sent to the patient."
        />
      );

    case "update_contact": {
      const fields = arr<{ field: string; value: string }>(data.fields);
      const write = (next: typeof fields) => set({ fields: next });
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Fields to set</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-xs"
              disabled={fields.length >= 10}
              onClick={() => write([...fields, { field: "language", value: "" }])}
            >
              <Plus className="size-3" />
              Add
            </Button>
          </div>
          {fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
              <Select
                value={f.field}
                onValueChange={(v) =>
                  write(fields.map((x, j) => (j === i ? { ...x, field: v } : x)))
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_FIELDS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                aria-label="Value"
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                value={f.value}
                onChange={(e) =>
                  write(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                }
                placeholder="Value or {vars.answer}"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Remove"
                onClick={() => write(fields.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      );
    }

    case "enquiry": {
      const pipeline = lookups.pipelines.find((p) => p.id === data.pipelineId);
      return (
        <div className="space-y-3">
          <SelectField
            label="Action"
            value={s(data.action, "create")}
            onChange={(v) => set({ action: v })}
            options={[
              { value: "create", label: "Create an enquiry" },
              { value: "update", label: "Update the enquiry in this run" },
            ]}
          />
          {s(data.action, "create") === "create" ? (
            <>
              <SelectField
                label="Pipeline"
                value={s(data.pipelineId) || undefined}
                allowNone
                noneLabel="Default pipeline"
                onChange={(v) => set({ pipelineId: v, stageId: undefined })}
                options={opt(lookups.pipelines)}
              />
              {pipeline ? (
                <SelectField
                  label="Stage"
                  value={s(data.stageId) || undefined}
                  allowNone
                  noneLabel="First stage"
                  onChange={(v) => set({ stageId: v })}
                  options={opt(pipeline.stages)}
                />
              ) : null}
              <TextField
                label="Title"
                value={s(data.subject)}
                onChange={(v) => set({ subject: v })}
                interpolate
                max={200}
                placeholder="New enquiry"
              />
            </>
          ) : (
            <>
              <SelectField
                label="Move to stage"
                value={s(data.stageId) || undefined}
                allowNone
                noneLabel="Leave the stage"
                onChange={(v) => set({ stageId: v })}
                options={lookups.pipelines.flatMap((p) =>
                  p.stages.map((st) => ({ value: st.id, label: `${p.name} › ${st.name}` })),
                )}
              />
              <SelectField
                label="Set status"
                value={s(data.status) || undefined}
                allowNone
                noneLabel="Leave the status"
                onChange={(v) => set({ status: v })}
                options={[
                  { value: "won", label: "Won" },
                  { value: "lost", label: "Lost" },
                ]}
              />
              {data.status === "lost" ? (
                <TextField
                  label="Reason"
                  value={s(data.lostReason)}
                  onChange={(v) => set({ lostReason: v })}
                  max={200}
                />
              ) : null}
              <TextField
                label="New title"
                value={s(data.subject)}
                onChange={(v) => set({ subject: v })}
                interpolate
                max={200}
              />
            </>
          )}
        </div>
      );
    }

    case "add_task":
      return (
        <div className="space-y-3">
          <TextField
            label="Task"
            value={s(data.subject)}
            onChange={(v) => set({ subject: v })}
            interpolate
            max={200}
          />
          <TextField
            label="Notes"
            value={s(data.notes)}
            onChange={(v) => set({ notes: v || undefined })}
            multiline
            max={1000}
            interpolate
          />
          <NumberField
            label="Due in (hours)"
            value={n(data.dueInHours) ?? 24}
            min={0}
            max={2160}
            onChange={(v) => set({ dueInHours: v ?? 24 })}
          />
          <SelectField
            label="Assign to"
            value={s(data.assigneeId) || undefined}
            allowNone
            noneLabel="Unassigned"
            onChange={(v) => set({ assigneeId: v })}
            options={opt(lookups.people)}
          />
        </div>
      );

    case "portal_record": {
      const obj = lookups.portalObjects.find((o) => o.key === data.objectKey);
      return (
        <div className="space-y-3">
          <SelectField
            label="Record type"
            value={s(data.objectKey) || undefined}
            onChange={(v) => set({ objectKey: v })}
            options={lookups.portalObjects.map((o) => ({ value: o.key, label: o.label }))}
            help="Only record types you are allowed to edit are listed; the flow can write exactly what you can."
          />
          <SelectField
            label="Action"
            value={s(data.action, "create")}
            onChange={(v) => set({ action: v })}
            options={[
              { value: "create", label: "Create a record" },
              { value: "update", label: "Update a record" },
            ]}
          />
          {s(data.action) === "update" ? (
            <TextField
              label="Record id"
              value={s(data.recordId)}
              onChange={(v) => set({ recordId: v })}
              interpolate
              mono
              help="Usually {steps.<earlier step>.id} or a value from the webhook."
            />
          ) : null}
          <KeyValueEditor
            label="Fields"
            keyLabel="Field"
            keyOptions={obj?.fields}
            value={rec(data.values)}
            onChange={(v) => set({ values: v })}
          />
        </div>
      );
    }

    case "appointment": {
      const action = s(data.action, "set_status");
      return (
        <div className="space-y-3">
          <SelectField
            label="Action"
            value={action}
            onChange={(v) => set({ action: v })}
            options={[
              { value: "set_status", label: "Confirm or cancel an appointment" },
              { value: "create", label: "Book an appointment" },
            ]}
          />
          {action === "set_status" ? (
            <>
              <SelectField
                label="Set to"
                value={s(data.status) || undefined}
                onChange={(v) => set({ status: v })}
                options={[
                  { value: "confirmed", label: "Confirmed" },
                  { value: "cancelled", label: "Cancelled" },
                ]}
              />
              <TextField
                label="Appointment id"
                value={s(data.appointmentId)}
                mono
                onChange={(v) => set({ appointmentId: v || undefined })}
                interpolate
                help="Leave empty to use the appointment that started this run."
              />
            </>
          ) : (
            <>
              <SelectField
                label="Doctor"
                value={s(data.specialistId) || undefined}
                onChange={(v) => set({ specialistId: v })}
                options={opt(lookups.specialists)}
              />
              <SelectField
                label="Location"
                value={s(data.locationId) || undefined}
                onChange={(v) => set({ locationId: v })}
                options={opt(lookups.locations)}
              />
              <SelectField
                label="Service"
                value={s(data.serviceId) || undefined}
                onChange={(v) => set({ serviceId: v })}
                options={opt(lookups.services)}
              />
              <TextField
                label="Starts at"
                value={s(data.startsAt)}
                onChange={(v) => set({ startsAt: v })}
                interpolate
                mono
                placeholder="{vars.slot}"
                help="An ISO date-time, e.g. 2026-10-20T10:00:00+04:00. The booking is refused if the slot is not free."
              />
            </>
          )}
        </div>
      );
    }

    case "api_action":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <SelectField
              label="Method"
              value={s(data.method, "POST")}
              onChange={(v) => set({ method: v })}
              options={[
                { value: "GET", label: "GET" },
                { value: "POST", label: "POST" },
              ]}
            />
            <TextField
              label="URL (https only)"
              value={s(data.url)}
              onChange={(v) => set({ url: v })}
              interpolate
              mono
              placeholder="https://example.org/hook"
            />
          </div>
          <KeyValueEditor
            label="Headers"
            keyLabel="Header"
            value={rec(data.headers)}
            onChange={(v) => set({ headers: v })}
          />
          {data.method !== "GET" ? (
            <TextField
              label="Body"
              value={s(data.body)}
              onChange={(v) => set({ body: v || undefined })}
              multiline
              max={10000}
              interpolate
              mono
            />
          ) : null}
          <TextField
            label="Save the response text to variable"
            value={s(data.saveAs)}
            onChange={(v) => set({ saveAs: v || undefined })}
            mono
            max={40}
            help="Optional. The parsed response is always available as {steps.<this step>.response.…}."
          />
          <p className="text-muted-foreground text-xs">
            Calls to private or local addresses are blocked. A failed call follows the “fallback”
            exit; without one, the run fails. Never put patient identifiers in a URL.
          </p>
        </div>
      );

    case "send_notification":
      return (
        <div className="space-y-3">
          <SelectField
            label="Notify a person"
            value={s(data.userId) || undefined}
            allowNone
            noneLabel="Everyone with a permission"
            onChange={(v) => set({ userId: v })}
            options={opt(lookups.people)}
          />
          {!data.userId ? (
            <SelectField
              label="…everyone who can"
              value={s(data.permission) || undefined}
              onChange={(v) => set({ permission: v })}
              options={lookups.permissions.map((p) => ({ value: p, label: p }))}
            />
          ) : null}
          <TextField
            label="Title"
            value={s(data.title)}
            onChange={(v) => set({ title: v })}
            interpolate
            max={120}
          />
          <TextField
            label="Details"
            value={s(data.body)}
            onChange={(v) => set({ body: v || undefined })}
            multiline
            max={500}
            interpolate
          />
        </div>
      );
  }
}

export function nodeSummary(type: NodeType, data: Data, lookups?: BuilderLookups): string {
  const clip = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}…` : t);
  switch (type) {
    case "message":
    case "add_comment":
      return clip(s(data.text));
    case "question":
      return clip(s(data.text)) + (data.variable ? ` → ${s(data.variable)}` : "");
    case "quick_reply":
      return clip(s(data.text));
    case "template":
      return lookups?.templates.find((t) => t.id === data.templateId)?.name ?? "Choose a template";
    case "wait":
      return `${n(data.amount) ?? "?"} ${s(data.unit)}`;
    case "run_flow":
      return lookups?.flows.find((f) => f.id === data.flowId)?.name ?? "Choose a flow";
    case "assign_to":
      return (
        lookups?.people.find((p) => p.id === data.userId)?.name ??
        lookups?.teams.find((t) => t.id === data.teamId)?.name ??
        "Choose who"
      );
    case "enquiry":
      return s(data.action, "create") === "create" ? "Create enquiry" : "Update enquiry";
    case "add_task":
      return clip(s(data.subject));
    case "portal_record":
      return `${s(data.action, "create")} ${s(data.objectKey)}`;
    case "appointment":
      return s(data.action) === "create" ? "Book appointment" : `Set ${s(data.status) || "status"}`;
    case "api_action":
      return clip(`${s(data.method, "POST")} ${s(data.url)}`);
    case "send_notification":
      return clip(s(data.title));
    case "update_contact":
      return arr<{ field: string }>(data.fields)
        .map((f) => f.field)
        .join(", ");
    default:
      return "";
  }
}

export { NODE_META };
