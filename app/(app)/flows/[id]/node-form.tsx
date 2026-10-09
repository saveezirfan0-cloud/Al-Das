"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { BRANCH_OPS } from "@/lib/flow-engine/conditions";
import { DAYS } from "@/lib/flow-engine/office-hours";
import type { NodeType } from "@/lib/flow-engine/types";

import { AreaField, Field, KvEditor, NumberField, SelectField, TextField, type Option, OptionsEditor } from "./fields";
import type { BuilderLookups } from "./flow-builder";

type Config = Record<string, unknown>;
type Props = { type: NodeType; config: Config; onChange: (next: Config) => void; lookups: BuilderLookups };

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

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

const DAY_LABELS: Record<(typeof DAYS)[number], string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

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
      return <AreaField label="Message" value={str(config.text)} onChange={(text) => set({ text })} variables={variables} hint="Free-form messages only work inside the patient's 24-hour window. Otherwise use a Template." />;

    case "question": {
      const style = str(config.style, "text");
      const options = arr<Option>(config.options);
      return (
        <div className="flex flex-col gap-3">
          <AreaField label="Question" value={str(config.text)} onChange={(text) => set({ text })} variables={variables} rows={3} />
          <SelectField
            label="Answer type"
            value={style}
            onChange={(s) => set({ style: s, options: s === "text" ? [] : options.length ? options : [{ id: "option_1", title: "Yes" }] })}
            options={[
              { value: "buttons", label: "Buttons (up to 3)" },
              { value: "list", label: "List (up to 10 rows)" },
              { value: "text", label: "Free text" },
            ]}
          />
          {style !== "text" && <OptionsEditor label="Options" value={options} onChange={(o) => set({ options: o })} max={style === "buttons" ? 3 : 10} hint="Each option gets its own output on the canvas." />}
          <TextField label="Save answer as variable" value={str(config.variable)} onChange={(v) => set({ variable: v || undefined })} placeholder="answer" mono hint="Use it later as {vars.answer}." />
          <NumberField label="Give up after (seconds)" value={num(config.timeout_seconds)} onChange={(v) => set({ timeout_seconds: v })} min={30} hint="Optional. On timeout the 'No / other answer' output runs." />
        </div>
      );
    }

    case "quick_reply":
      return (
        <div className="flex flex-col gap-3">
          <AreaField label="Message" value={str(config.text)} onChange={(text) => set({ text })} variables={variables} rows={3} />
          <OptionsEditor label="Buttons" value={arr<Option>(config.buttons)} onChange={(buttons) => set({ buttons })} max={3} />
        </div>
      );

    case "template": {
      const tpl = lookups.templates.find((t) => t.id === str(config.template_id));
      return (
        <div className="flex flex-col gap-3">
          <SelectField label="Template" value={str(config.template_id)} onChange={(v) => set({ template_id: v })} options={lookups.templates.map((t) => ({ value: t.id, label: `${t.name}${t.status === "APPROVED" ? "" : ` (${t.status})`}` }))} />
          {tpl && tpl.status !== "APPROVED" && <p className="text-xs text-amber-700">This template is {tpl.status}; the step will fail until it is approved.</p>}
          <KvEditor label="Variable overrides" value={obj(config.values) as Record<string, string>} onChange={(values) => set({ values })} keyPlaceholder="body.1" valuePlaceholder="{contact.first_name}" hint="Optional. Defaults come from the template's variable map." />
        </div>
      );
    }

    case "branch": {
      const conds = arr<{ left: string; op: string; right?: string }>(config.conditions);
      const update = (i: number, patch: Partial<{ left: string; op: string; right: string }>) => set({ conditions: conds.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
      return (
        <div className="flex flex-col gap-3">
          <SelectField label="Match" value={str(config.logic, "and")} onChange={(logic) => set({ logic })} options={[{ value: "and", label: "All conditions" }, { value: "or", label: "Any condition" }]} />
          {conds.map((c, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2">
              <Input aria-label={`Condition ${i + 1} value to check`} value={c.left} onChange={(e) => update(i, { left: e.target.value })} placeholder="vars.answer" className="font-mono text-xs" />
              <SelectField label="Is" value={c.op} onChange={(op) => update(i, { op })} options={BRANCH_OPS.map((o) => ({ value: o, label: OP_LABELS[o] ?? o }))} />
              {!["is_empty", "is_not_empty"].includes(c.op) && <Input aria-label={`Condition ${i + 1} compare to`} value={c.right ?? ""} onChange={(e) => update(i, { right: e.target.value })} placeholder="Compare to" />}
              <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => set({ conditions: conds.filter((_, j) => j !== i) })}>
                <Trash2 /> Remove
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => set({ conditions: [...conds, { left: "vars.", op: "eq", right: "" }] })}>
            <Plus /> Add condition
          </Button>
          <p className="text-muted-foreground text-xs">Empty or unknown values count as false, never true.</p>
        </div>
      );
    }

    case "wait":
      return (
        <div className="flex flex-col gap-3">
          <NumberField label="Wait for" value={num(config.amount)} onChange={(amount) => set({ amount })} min={1} />
          <SelectField label="Unit" value={str(config.unit, "hours")} onChange={(unit) => set({ unit })} options={["seconds", "minutes", "hours", "days"].map((u) => ({ value: u, label: u }))} hint="Up to 30 days. The flow resumes from a scheduled job, so it survives restarts." />
        </div>
      );

    case "office_hours": {
      const schedule = obj(config.schedule);
      const slots = (d: string) => arr<{ start: string; end: string }>(schedule[d]);
      const setDay = (d: string, v: Array<{ start: string; end: string }>) => set({ schedule: { ...schedule, [d]: v } });
      return (
        <div className="flex flex-col gap-3">
          <TextField label="Timezone" value={str(config.timezone, "Asia/Dubai")} onChange={(timezone) => set({ timezone })} mono />
          {DAYS.map((d) => (
            <Field key={d} label={DAY_LABELS[d]}>
              <div className="flex flex-col gap-1">
                {slots(d).map((s, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <Input type="time" aria-label={`${DAY_LABELS[d]} from`} value={s.start} onChange={(e) => setDay(d, slots(d).map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                    <span className="text-muted-foreground text-xs">to</span>
                    <Input type="time" aria-label={`${DAY_LABELS[d]} to`} value={s.end} onChange={(e) => setDay(d, slots(d).map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${DAY_LABELS[d]} slot`} onClick={() => setDay(d, slots(d).filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                {slots(d).length < 4 && (
                  <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setDay(d, [...slots(d), { start: "09:00", end: "18:00" }])}>
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
      return <SelectField label="Flow to run" value={str(config.flow_id)} onChange={(flow_id) => set({ flow_id })} options={lookups.flows.map((f) => ({ value: f.id, label: f.published ? f.name : `${f.name} (not published)` }))} hint="The nested flow must be published. When it ends, this flow continues." />;

    case "end_flow":
    case "close_conversation":
    case "trigger":
      return <p className="text-muted-foreground text-sm">{type === "close_conversation" ? "Closes the conversation and ends the flow." : type === "end_flow" ? "Ends the flow here." : ""}</p>;

    case "assign_to": {
      const target = obj(config.target);
      const t = str(target.type, "team");
      return (
        <div className="flex flex-col gap-3">
          <SelectField
            label="Assign to"
            value={t}
            onChange={(type) => set({ target: type === "user" || type === "team" ? { type, id: "" } : { type } })}
            options={[{ value: "team", label: "A team" }, { value: "user", label: "A person" }, { value: "bot", label: "The bot (keep automating)" }, { value: "unassign", label: "Nobody (unassign)" }]}
          />
          {t === "team" && <SelectField label="Team" value={str(target.id)} onChange={(id) => set({ target: { type: "team", id } })} options={lookups.teams.map((x) => ({ value: x.id, label: x.name }))} />}
          {t === "user" && <SelectField label="Person" value={str(target.id)} onChange={(id) => set({ target: { type: "user", id } })} options={lookups.people.map((x) => ({ value: x.id, label: x.name }))} />}
          {(t === "team" || t === "user") && <p className="text-muted-foreground text-xs">Handing over to people ends the flow (human takeover).</p>}
        </div>
      );
    }

    case "add_comment":
      return <AreaField label="Internal note" value={str(config.text)} onChange={(text) => set({ text })} variables={variables} rows={3} hint="Visible to the team only; never sent to the patient." />;

    case "update_contact_field": {
      const field = str(config.field, "label");
      const custom = field.startsWith("custom.");
      return (
        <div className="flex flex-col gap-3">
          <SelectField label="Field" value={custom ? "custom" : field} onChange={(f) => set({ field: f === "custom" ? "custom." : f })} options={[...CONTACT_FIELDS, { value: "custom", label: "Custom field…" }]} hint="The phone number identifies the patient and cannot be changed by a flow." />
          {custom && <TextField label="Custom field key" value={field.slice(7)} onChange={(k) => set({ field: `custom.${k}` })} mono />}
          <TextField label="New value" value={str(config.value)} onChange={(value) => set({ value })} hint="Can use {contact.first_name}, {vars.NAME}, {steps.<node>.response.x}." />
        </div>
      );
    }

    case "create_enquiry":
    case "add_task":
    case "portal_record":
    case "book_appointment":
      return (
        <div className="flex flex-col gap-3">
          <p className="rounded-lg border border-dashed p-2 text-xs text-muted-foreground">This module is installed in a later phase. Until then the step stops with a clear message (or follows its error output). Settings you enter are kept.</p>
          <KvEditor label="Settings" value={obj(config) as Record<string, string>} onChange={(v) => onChange(v)} keyPlaceholder="field" valuePlaceholder="value or {variable}" />
        </div>
      );

    case "api_action":
      return (
        <div className="flex flex-col gap-3">
          <SelectField label="Method" value={str(config.method, "POST")} onChange={(method) => set({ method })} options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))} />
          <TextField label="URL" value={str(config.url)} onChange={(url) => set({ url })} mono hint="https only. Private and internal addresses are blocked. Can use {variables}." />
          <KvEditor label="Headers" value={obj(config.headers) as Record<string, string>} onChange={(headers) => set({ headers })} hint="Header values are not shown in run logs." />
          <AreaField label="Body" value={str(config.body)} onChange={(body) => set({ body })} variables={variables} rows={4} />
          <NumberField label="Timeout (seconds)" value={num(config.timeout_seconds)} onChange={(v) => set({ timeout_seconds: v ?? 10 })} min={1} max={30} />
          <p className="text-muted-foreground text-xs">The JSON response is available later as {"{steps.<this step>.response.field}"}. A non-2xx response uses the error output.</p>
        </div>
      );

    case "send_notification": {
      const target = obj(config.target);
      const t = str(target.type, "role");
      return (
        <div className="flex flex-col gap-3">
          <SelectField label="Notify" value={t} onChange={(type) => set({ target: { type, id: "" } })} options={[{ value: "role", label: "Everyone with a role" }, { value: "team", label: "A team" }, { value: "user", label: "A person" }]} />
          {t === "role" && <TextField label="Role name" value={str(target.id)} onChange={(id) => set({ target: { type: "role", id } })} placeholder="Manager" />}
          {t === "team" && <SelectField label="Team" value={str(target.id)} onChange={(id) => set({ target: { type: "team", id } })} options={lookups.teams.map((x) => ({ value: x.id, label: x.name }))} />}
          {t === "user" && <SelectField label="Person" value={str(target.id)} onChange={(id) => set({ target: { type: "user", id } })} options={lookups.people.map((x) => ({ value: x.id, label: x.name }))} />}
          <TextField label="Title" value={str(config.title)} onChange={(title) => set({ title })} />
          <AreaField label="Details" value={str(config.body)} onChange={(body) => set({ body })} variables={variables} rows={2} />
        </div>
      );
    }
  }
}


