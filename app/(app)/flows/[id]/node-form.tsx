"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { INTENT_LABELS } from "@/lib/ai/intent/labels";
import { BRANCH_OPS } from "@/lib/flow-engine/conditions";
import {
  ANSWER_TYPE_LABELS,
  ANSWER_TYPES,
  META_EVENT_NAMES,
  ROUTABLE_INTENTS,
} from "@/lib/flow-engine/node-options";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import { DAYS } from "@/lib/flow-engine/office-hours";
import type { NodeType } from "@/lib/flow-engine/types";

import {
  AreaField,
  Field,
  KvEditor,
  NumberField,
  SelectField,
  TextField,
  type Option,
  OptionsEditor,
} from "./fields";
import type { BuilderLookups } from "./flow-builder";

type Config = Record<string, unknown>;
type Props = {
  type: NodeType;
  config: Config;
  onChange: (next: Config) => void;
  lookups: BuilderLookups;
};

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const OP_LABELS: Record<string, string> = {
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  in: "is one of (comma list)",
};

const DAY_LABELS: Record<(typeof DAYS)[number], string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const CONTACT_FIELDS = [
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "email", label: "Email" },
  { value: "gender", label: "Gender (female / male / other / unknown)" },
  { value: "language", label: "Language" },
  { value: "label", label: "Label" },
];

export function NodeForm({ type, config, onChange, lookups }: Props) {
  const set = (patch: Config) => onChange({ ...config, ...patch });
  const { variables } = lookups;

  switch (type) {
    case "message":
      return (
        <AreaField
          label="Message"
          value={str(config.text)}
          onChange={(text) => set({ text })}
          variables={variables}
          hint="Free-form messages only work inside the patient's 24-hour window. Otherwise use a Template."
        />
      );

    case "question": {
      const style = str(config.style, "text");
      const options = arr<Option>(config.options);
      return (
        <div className="flex flex-col gap-3">
          <AreaField
            label="Question"
            value={str(config.text)}
            onChange={(text) => set({ text })}
            variables={variables}
            rows={3}
          />
          <SelectField
            label="Answer type"
            value={style}
            onChange={(s) =>
              set({
                style: s,
                options:
                  s === "text" ? [] : options.length ? options : [{ id: "option_1", title: "Yes" }],
              })
            }
            options={[
              { value: "buttons", label: "Buttons (up to 3)" },
              { value: "list", label: "List (up to 10 rows)" },
              { value: "text", label: "Free text" },
            ]}
          />
          {style !== "text" && (
            <OptionsEditor
              label="Options"
              value={options}
              onChange={(o) => set({ options: o })}
              max={style === "buttons" ? 3 : 10}
              hint="Each option gets its own output on the canvas."
            />
          )}
          {style === "text" && (
            <>
              <SelectField
                label="A valid answer is"
                value={str(config.answer_type, "text")}
                onChange={(answer_type) => set({ answer_type })}
                options={ANSWER_TYPES.map((t) => ({ value: t, label: ANSWER_TYPE_LABELS[t] }))}
                hint="Phone numbers are saved as +971…, dates as YYYY-MM-DD (day first when typed with slashes)."
              />
              {str(config.answer_type) === "number" && (
                <div className="flex gap-2">
                  <NumberField
                    label="Lowest"
                    value={num(config.min)}
                    onChange={(min) => set({ min })}
                  />
                  <NumberField
                    label="Highest"
                    value={num(config.max)}
                    onChange={(max) => set({ max })}
                  />
                </div>
              )}
              {str(config.answer_type) === "regex" && (
                <TextField
                  label="Pattern"
                  value={str(config.pattern)}
                  onChange={(pattern) => set({ pattern })}
                  placeholder="^[A-Z]{2}[0-9]{6}$"
                  mono
                  hint="A regular expression the answer must match. Up to 200 characters; repeating a group that already repeats is not allowed."
                />
              )}
            </>
          )}
          <NumberField
            label="Ask again (times)"
            value={num(config.reask_max) ?? 0}
            onChange={(v) => set({ reask_max: v ?? 0 })}
            min={0}
            max={5}
            hint="When the answer does not fit. After that the 'No / other answer' output runs; without it the flow stops and the chat goes back to the team."
          />
          {(num(config.reask_max) ?? 0) > 0 && (
            <AreaField
              label="Ask again with"
              value={str(config.reask_text)}
              onChange={(reask_text) => set({ reask_text: reask_text || undefined })}
              variables={variables}
              rows={2}
              hint="Optional. Empty repeats the question."
            />
          )}
          <TextField
            label="Save answer as variable"
            value={str(config.variable)}
            onChange={(v) => set({ variable: v || undefined })}
            placeholder="answer"
            mono
            hint="Use it later as {vars.answer}."
          />
          <SelectField
            label="Also save to patient field"
            value={str(config.save_to, "none")}
            onChange={(v) => set({ save_to: v === "none" ? undefined : v })}
            options={[
              { value: "none", label: "Do not save" },
              ...CONTACT_FIELDS.filter((f) => f.value !== "gender"),
            ]}
            hint="Only an e-mail answer can go to the e-mail field. For a custom field use Update patient field with {vars.answer}."
          />
          <NumberField
            label="Give up after (seconds)"
            value={num(config.timeout_seconds)}
            onChange={(v) => set({ timeout_seconds: v })}
            min={30}
            hint="Optional. On timeout the 'No / other answer' output runs."
          />
        </div>
      );
    }

    case "quick_reply":
      return (
        <div className="flex flex-col gap-3">
          <AreaField
            label="Message"
            value={str(config.text)}
            onChange={(text) => set({ text })}
            variables={variables}
            rows={3}
          />
          <OptionsEditor
            label="Buttons"
            value={arr<Option>(config.buttons)}
            onChange={(buttons) => set({ buttons })}
            max={3}
          />
        </div>
      );

    case "template": {
      const tpl = lookups.templates.find((t) => t.id === str(config.template_id));
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Template"
            value={str(config.template_id)}
            onChange={(v) => set({ template_id: v })}
            options={lookups.templates.map((t) => ({
              value: t.id,
              label: `${t.name}${t.status === "APPROVED" ? "" : ` (${t.status})`}`,
            }))}
          />
          {tpl && tpl.status !== "APPROVED" && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              This template is {tpl.status}; the step will fail until it is approved.
            </p>
          )}
          <KvEditor
            label="Variable overrides"
            value={obj(config.values) as Record<string, string>}
            onChange={(values) => set({ values })}
            keyPlaceholder="body.1"
            valuePlaceholder="{contact.first_name}"
            hint="Optional. Defaults come from the template's variable map."
          />
        </div>
      );
    }

    case "branch": {
      const conds = arr<{ left: string; op: string; right?: string }>(config.conditions);
      const update = (i: number, patch: Partial<{ left: string; op: string; right: string }>) =>
        set({ conditions: conds.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Match"
            value={str(config.logic, "and")}
            onChange={(logic) => set({ logic })}
            options={[
              { value: "and", label: "All conditions" },
              { value: "or", label: "Any condition" },
            ]}
          />
          {conds.map((c, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2">
              <Input
                aria-label={`Condition ${i + 1} value to check`}
                value={c.left}
                onChange={(e) => update(i, { left: e.target.value })}
                placeholder="vars.answer"
                className="font-mono text-xs"
              />
              <SelectField
                label="Is"
                value={c.op}
                onChange={(op) => update(i, { op })}
                options={BRANCH_OPS.map((o) => ({ value: o, label: OP_LABELS[o] ?? o }))}
              />
              {!["is_empty", "is_not_empty"].includes(c.op) && (
                <Input
                  aria-label={`Condition ${i + 1} compare to`}
                  value={c.right ?? ""}
                  onChange={(e) => update(i, { right: e.target.value })}
                  placeholder="Compare to"
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-end"
                onClick={() => set({ conditions: conds.filter((_, j) => j !== i) })}
              >
                <Trash2 /> Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set({ conditions: [...conds, { left: "vars.", op: "eq", right: "" }] })}
          >
            <Plus /> Add condition
          </Button>
          <p className="text-muted-foreground text-xs">
            Empty or unknown values count as false, never true.
          </p>
        </div>
      );
    }

    case "wait":
      return (
        <div className="flex flex-col gap-3">
          <NumberField
            label="Wait for"
            value={num(config.amount)}
            onChange={(amount) => set({ amount })}
            min={1}
          />
          <SelectField
            label="Unit"
            value={str(config.unit, "hours")}
            onChange={(unit) => set({ unit })}
            options={["seconds", "minutes", "hours", "days"].map((u) => ({ value: u, label: u }))}
            hint="Up to 30 days. The flow resumes from a scheduled job, so it survives restarts."
          />
        </div>
      );

    case "office_hours": {
      const schedule = obj(config.schedule);
      const slots = (d: string) => arr<{ start: string; end: string }>(schedule[d]);
      const setDay = (d: string, v: Array<{ start: string; end: string }>) =>
        set({ schedule: { ...schedule, [d]: v } });
      return (
        <div className="flex flex-col gap-3">
          <TextField
            label="Timezone"
            value={str(config.timezone, "Asia/Dubai")}
            onChange={(timezone) => set({ timezone })}
            mono
          />
          {DAYS.map((d) => (
            <Field key={d} label={DAY_LABELS[d]}>
              <div className="flex flex-col gap-1">
                {slots(d).map((s, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <Input
                      type="time"
                      aria-label={`${DAY_LABELS[d]} from`}
                      value={s.start}
                      onChange={(e) =>
                        setDay(
                          d,
                          slots(d).map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                        )
                      }
                    />
                    <span className="text-muted-foreground text-xs">to</span>
                    <Input
                      type="time"
                      aria-label={`${DAY_LABELS[d]} to`}
                      value={s.end}
                      onChange={(e) =>
                        setDay(
                          d,
                          slots(d).map((x, j) => (j === i ? { ...x, end: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${DAY_LABELS[d]} slot`}
                      onClick={() =>
                        setDay(
                          d,
                          slots(d).filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                {slots(d).length < 4 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => setDay(d, [...slots(d), { start: "09:00", end: "18:00" }])}
                  >
                    <Plus /> {slots(d).length ? "Add slot" : "Closed — add hours"}
                  </Button>
                )}
              </div>
            </Field>
          ))}
        </div>
      );
    }

    case "run_flow":
      return (
        <SelectField
          label="Flow to run"
          value={str(config.flow_id)}
          onChange={(flow_id) => set({ flow_id })}
          options={lookups.flows.map((f) => ({
            value: f.id,
            label: f.published ? f.name : `${f.name} (not published)`,
          }))}
          hint="The nested flow must be published. When it ends, this flow continues."
        />
      );

    case "end_flow":
    case "close_conversation":
    case "trigger":
      return (
        <p className="text-muted-foreground text-sm">
          {type === "close_conversation"
            ? "Closes the conversation and ends the flow."
            : type === "end_flow"
              ? "Ends the flow here."
              : ""}
        </p>
      );

    case "assign_to": {
      const target = obj(config.target);
      const t = str(target.type, "team");
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Assign to"
            value={t}
            onChange={(type) =>
              set({ target: type === "user" || type === "team" ? { type, id: "" } : { type } })
            }
            options={[
              { value: "team", label: "A team" },
              { value: "user", label: "A person" },
              { value: "bot", label: "The bot (keep automating)" },
              { value: "unassign", label: "Nobody (unassign)" },
            ]}
          />
          {t === "team" && (
            <SelectField
              label="Team"
              value={str(target.id)}
              onChange={(id) => set({ target: { type: "team", id } })}
              options={lookups.teams.map((x) => ({ value: x.id, label: x.name }))}
            />
          )}
          {t === "user" && (
            <SelectField
              label="Person"
              value={str(target.id)}
              onChange={(id) => set({ target: { type: "user", id } })}
              options={lookups.people.map((x) => ({ value: x.id, label: x.name }))}
            />
          )}
          {(t === "team" || t === "user") && (
            <p className="text-muted-foreground text-xs">
              Handing over to people ends the flow (human takeover).
            </p>
          )}
        </div>
      );
    }

    case "add_comment":
      return (
        <AreaField
          label="Internal note"
          value={str(config.text)}
          onChange={(text) => set({ text })}
          variables={variables}
          rows={3}
          hint="Visible to the team only; never sent to the patient."
        />
      );

    case "update_contact_field": {
      const field = str(config.field, "label");
      const custom = field.startsWith("custom.");
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Field"
            value={custom ? "custom" : field}
            onChange={(f) => set({ field: f === "custom" ? "custom." : f })}
            options={[...CONTACT_FIELDS, { value: "custom", label: "Custom field…" }]}
            hint="The phone number identifies the patient and cannot be changed by a flow."
          />
          {custom && (
            <TextField
              label="Custom field key"
              value={field.slice(7)}
              onChange={(k) => set({ field: `custom.${k}` })}
              mono
            />
          )}
          <TextField
            label="New value"
            value={str(config.value)}
            onChange={(value) => set({ value })}
            hint="Can use {contact.first_name}, {vars.NAME}, {steps.<node>.response.x}."
          />
        </div>
      );
    }

    case "create_enquiry": {
      const pipelines = lookups.pipelines ?? [];
      const pipeline = pipelines.find((p) => p.id === str(config.pipeline_id));
      return (
        <div className="flex flex-col gap-3">
          <TextField
            label="Title"
            value={str(config.title)}
            onChange={(title) => set({ title })}
            hint="Can use {contact.first_name} and other variables."
          />
          <SelectField
            label="Pipeline"
            value={str(config.pipeline_id, "default")}
            onChange={(v) =>
              set({ pipeline_id: v === "default" ? undefined : v, stage_id: undefined })
            }
            options={[
              { value: "default", label: "The default pipeline" },
              ...pipelines.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {pipeline && (
            <SelectField
              label="Stage"
              value={str(config.stage_id, "first")}
              onChange={(v) => set({ stage_id: v === "first" ? undefined : v })}
              options={[
                { value: "first", label: "The first stage" },
                ...pipeline.stages.map((st) => ({ value: st.id, label: st.name })),
              ]}
            />
          )}
          <TextField
            label="Source (optional)"
            value={str(config.source)}
            onChange={(source) => set({ source: source || undefined })}
            placeholder="WhatsApp"
          />
          <SelectField
            label="If the patient already has an open enquiry here"
            value={str(config.if_open, "update")}
            onChange={(if_open) => set({ if_open })}
            options={[
              { value: "update", label: "Use it (move it to the stage above)" },
              { value: "create", label: "Create another one" },
            ]}
            hint="Later Update enquiry steps act on this enquiry. The usual assignment rules, SLA and events apply."
          />
        </div>
      );
    }

    case "update_enquiry": {
      const action = str(config.action, "stage");
      const pipelines = lookups.pipelines ?? [];
      const allStages = pipelines.flatMap((p) =>
        p.stages.map((st) => ({ value: st.id, label: `${p.name}: ${st.name}` })),
      );
      const target = pipelines.find((p) => p.id === str(config.pipeline_id));
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Change"
            value={action}
            onChange={(a) => onChange({ action: a })}
            options={[
              { value: "stage", label: "Stage" },
              { value: "status", label: "Status (won / lost / disqualified / open)" },
              { value: "pipeline", label: "Move to another pipeline" },
              { value: "field", label: "A field" },
            ]}
            hint="Acts on the enquiry created earlier in this flow, else the one the flow started from."
          />
          {action === "stage" && (
            <SelectField
              label="Stage"
              value={str(config.stage_id)}
              onChange={(stage_id) => set({ stage_id })}
              options={allStages}
              hint="Must be a stage of the enquiry's own pipeline."
            />
          )}
          {action === "status" && (
            <>
              <SelectField
                label="Status"
                value={str(config.status)}
                onChange={(status) => set({ status })}
                options={[
                  { value: "open", label: "Open" },
                  { value: "won", label: "Won" },
                  { value: "lost", label: "Lost" },
                  { value: "disqualified", label: "Disqualified" },
                ]}
              />
              {["lost", "disqualified"].includes(str(config.status)) && (
                <TextField
                  label="Reason"
                  value={str(config.lost_reason)}
                  onChange={(lost_reason) => set({ lost_reason })}
                  placeholder={lookups.lostReasons?.[0] ?? "Reason"}
                  hint={
                    lookups.lostReasons?.length
                      ? `Workspace reasons: ${lookups.lostReasons.slice(0, 6).join(", ")}`
                      : "Required for lost and disqualified."
                  }
                />
              )}
            </>
          )}
          {action === "pipeline" && (
            <>
              <SelectField
                label="Pipeline"
                value={str(config.pipeline_id)}
                onChange={(pipeline_id) => set({ pipeline_id, stage_id: undefined })}
                options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
              />
              {target && (
                <SelectField
                  label="Stage"
                  value={str(config.stage_id, "first")}
                  onChange={(v) => set({ stage_id: v === "first" ? undefined : v })}
                  options={[
                    { value: "first", label: "The first stage" },
                    ...target.stages.map((st) => ({ value: st.id, label: st.name })),
                  ]}
                />
              )}
            </>
          )}
          {action === "field" && (
            <>
              <SelectField
                label="Field"
                value={str(config.field)}
                onChange={(field) => set({ field })}
                options={[
                  { value: "title", label: "Title" },
                  { value: "source", label: "Source" },
                  { value: "est_value", label: "Estimated value" },
                  { value: "appt_date", label: "Appointment date" },
                  ...(lookups.enquiryFields ?? []).map((f) => ({
                    value: `custom.${f.key}`,
                    label: f.label,
                  })),
                ]}
              />
              <TextField
                label="Value"
                value={str(config.value)}
                onChange={(value) => set({ value })}
                hint="Can use {variables}. Empty clears the field (not the title)."
              />
            </>
          )}
        </div>
      );
    }

    case "add_task":
      return (
        <div className="flex flex-col gap-3">
          <TextField
            label="Subject"
            value={str(config.subject)}
            onChange={(subject) => set({ subject })}
          />
          <SelectField
            label="Type"
            value={str(config.type, "follow_up")}
            onChange={(type) => set({ type })}
            options={[
              { value: "call", label: "Call" },
              { value: "follow_up", label: "Follow-up" },
              { value: "email", label: "E-mail" },
              { value: "meeting", label: "Meeting" },
              { value: "other", label: "Other" },
            ]}
          />
          <NumberField
            label="Due in (hours)"
            value={num(config.due_in_hours) ?? 24}
            onChange={(v) => set({ due_in_hours: v ?? 24 })}
            min={0}
            max={2160}
          />
          <SelectField
            label="Assign to"
            value={str(config.assignee_id, "none")}
            onChange={(v) => set({ assignee_id: v === "none" ? undefined : v })}
            options={[
              { value: "none", label: "Nobody (team list)" },
              ...lookups.people.map((x) => ({ value: x.id, label: x.name })),
            ]}
          />
          <AreaField
            label="Notes"
            value={str(config.notes)}
            onChange={(notes) => set({ notes: notes || undefined })}
            variables={variables}
            rows={2}
          />
        </div>
      );

    case "portal_record": {
      const def = PORTAL_OBJECTS.find((o) => o.key === str(config.object));
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Object"
            value={str(config.object)}
            onChange={(object) => set({ object, values: {} })}
            options={PORTAL_OBJECTS.filter((o) => o.writePerm).map((o) => ({
              value: o.key,
              label: o.label,
            }))}
            hint="Runs with the portal permissions of whoever publishes this flow, checked on every run."
          />
          <SelectField
            label="Do"
            value={str(config.mode, "create")}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "create", label: "Create a record" },
              { value: "update", label: "Update a record" },
            ]}
          />
          {str(config.mode) === "update" && (
            <TextField
              label="Record id"
              value={str(config.record_id)}
              onChange={(record_id) => set({ record_id })}
              placeholder="{vars.record_id}"
              mono
            />
          )}
          <KvEditor
            label="Values"
            value={obj(config.values) as Record<string, string>}
            onChange={(values) => set({ values })}
            keyPlaceholder={def?.columns.find((c) => !c.readOnly)?.key ?? "column"}
            valuePlaceholder="value or {variable}"
            hint={
              def
                ? `Columns: ${def.columns
                    .filter((c) => !c.readOnly)
                    .map((c) => c.key)
                    .slice(0, 12)
                    .join(", ")}. Each value is checked the way the portal form checks it.`
                : undefined
            }
          />
        </div>
      );
    }

    case "book_appointment":
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Service"
            value={str(config.service_id)}
            onChange={(service_id) => set({ service_id })}
            options={(lookups.services ?? []).map((x) => ({ value: x.id, label: x.name }))}
          />
          <SelectField
            label="Doctor"
            value={str(config.specialist_id)}
            onChange={(specialist_id) => set({ specialist_id })}
            options={(lookups.specialists ?? []).map((x) => ({ value: x.id, label: x.name }))}
          />
          <SelectField
            label="Location"
            value={str(config.location_id)}
            onChange={(location_id) => set({ location_id })}
            options={(lookups.locations ?? []).map((x) => ({ value: x.id, label: x.name }))}
          />
          <TextField
            label="Starts at"
            value={str(config.starts_at)}
            onChange={(starts_at) => set({ starts_at })}
            placeholder="{vars.slot}"
            mono
            hint="An ISO date and time, usually from a variable. Only a free slot in the future is booked, under the same lock as the calendar; nothing is written to Unite."
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.notify === true}
              onChange={(e) => set({ notify: e.target.checked })}
            />
            Send the booking confirmation template
          </label>
        </div>
      );

    case "set_label":
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Do"
            value={str(config.action, "add")}
            onChange={(action) => set({ action })}
            options={[
              { value: "add", label: "Add the label" },
              { value: "remove", label: "Remove the label" },
            ]}
          />
          <SelectField
            label="Label"
            value={str(config.tag_id)}
            onChange={(tag_id) => set({ tag_id })}
            options={(lookups.labels ?? []).map((x) => ({ value: x.id, label: x.name }))}
            hint="Conversation labels are managed under Settings, Tags."
          />
        </div>
      );

    case "payment_link":
      return (
        <div className="flex flex-col gap-3">
          <TextField
            label="Invoice number"
            value={str(config.invoice_number)}
            onChange={(invoice_number) => set({ invoice_number })}
            placeholder="{vars.invoice}"
            mono
          />
          <TextField
            label="Amount"
            value={str(config.amount)}
            onChange={(amount) => set({ amount })}
            placeholder="150.00"
            mono
            hint="Plain number in the integration's currency; never more than the invoice total."
          />
          <p className="text-muted-foreground text-xs">
            Uses the Payment links integration: it must be switched on and is never used in a
            training workspace. The invoice must be this patient&apos;s and have no open link. The
            approved payment template goes to the patient (or their guardian). Publishing needs the
            right to send payment links.
          </p>
        </div>
      );

    case "meta_event":
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Event"
            value={str(config.event_name, "Lead")}
            onChange={(event_name) => set({ event_name })}
            options={META_EVENT_NAMES.map((e) => ({ value: e, label: e }))}
          />
          <p className="text-muted-foreground text-xs">
            Only for a patient who came from a click-to-WhatsApp ad, only while Meta ad attribution
            is on in &quot;send events&quot; mode, and only with consent (a marketing stop always
            wins). Nothing about the visit is sent. The same event is never sent twice for the same
            enquiry or appointment.
          </p>
        </div>
      );

    case "ai_router": {
      const chosen = arr<string>(config.intents);
      return (
        <div className="flex flex-col gap-3">
          <Field label="Route on">
            <div className="flex flex-col gap-1.5">
              {ROUTABLE_INTENTS.map((i) => (
                <label key={i} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chosen.includes(i)}
                    onChange={(e) =>
                      set({
                        intents: e.target.checked ? [...chosen, i] : chosen.filter((x) => x !== i),
                      })
                    }
                  />
                  {INTENT_LABELS[i]}
                </label>
              ))}
            </div>
          </Field>
          <p className="text-muted-foreground text-xs">
            Looks at the patient&apos;s last message with the intent labels from Settings, AI
            copilots. Each label gets an output (the first one ticked that fits wins); Else runs
            when none fits or the AI is off. It never writes or sends AI text. A message that may
            describe an emergency stops the flow and goes to a person.
          </p>
        </div>
      );
    }

    case "api_action":
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Method"
            value={str(config.method, "POST")}
            onChange={(method) => set({ method })}
            options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
          />
          <TextField
            label="URL"
            value={str(config.url)}
            onChange={(url) => set({ url })}
            mono
            hint="https only. Private and internal addresses are blocked. Can use {variables}."
          />
          <KvEditor
            label="Headers"
            value={obj(config.headers) as Record<string, string>}
            onChange={(headers) => set({ headers })}
            hint="Header values are not shown in run logs."
          />
          <AreaField
            label="Body"
            value={str(config.body)}
            onChange={(body) => set({ body })}
            variables={variables}
            rows={4}
          />
          <NumberField
            label="Timeout (seconds)"
            value={num(config.timeout_seconds)}
            onChange={(v) => set({ timeout_seconds: v ?? 10 })}
            min={1}
            max={30}
          />
          <p className="text-muted-foreground text-xs">
            The JSON response is available later as {"{steps.<this step>.response.field}"}. A
            non-2xx response uses the error output.
          </p>
        </div>
      );

    case "send_notification": {
      const target = obj(config.target);
      const t = str(target.type, "role");
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Notify"
            value={t}
            onChange={(type) => set({ target: { type, id: "" } })}
            options={[
              { value: "role", label: "Everyone with a role" },
              { value: "team", label: "A team" },
              { value: "user", label: "A person" },
            ]}
          />
          {t === "role" && (
            <TextField
              label="Role name"
              value={str(target.id)}
              onChange={(id) => set({ target: { type: "role", id } })}
              placeholder="Manager"
            />
          )}
          {t === "team" && (
            <SelectField
              label="Team"
              value={str(target.id)}
              onChange={(id) => set({ target: { type: "team", id } })}
              options={lookups.teams.map((x) => ({ value: x.id, label: x.name }))}
            />
          )}
          {t === "user" && (
            <SelectField
              label="Person"
              value={str(target.id)}
              onChange={(id) => set({ target: { type: "user", id } })}
              options={lookups.people.map((x) => ({ value: x.id, label: x.name }))}
            />
          )}
          <TextField label="Title" value={str(config.title)} onChange={(title) => set({ title })} />
          <AreaField
            label="Details"
            value={str(config.body)}
            onChange={(body) => set({ body })}
            variables={variables}
            rows={2}
          />
        </div>
      );
    }
  }
}
