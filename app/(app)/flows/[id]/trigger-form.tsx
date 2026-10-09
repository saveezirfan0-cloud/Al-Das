"use client";

import { useState, useTransition } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TRIGGER_LABELS } from "@/lib/flow-engine/labels";
import { cronFromForm, describeSchedule, formFromCron, type ScheduleForm } from "@/lib/flow-engine/schedule";
import { CONDITION_CATEGORIES, CONDITION_OPS, TRIGGER_TYPES, type TriggerCondition } from "@/lib/flow-engine/types";

import { regenerateWebhookToken } from "../actions";
import { Field, SelectField, TextField } from "./fields";
import type { BuilderLookups } from "./flow-builder";

export type TriggerState = {
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  channel_id: string | null;
};

const CATEGORY_LABELS = { source: "Source", keyword: "Keyword", ad: "Ad" } as const;
const OP_LABELS = { equals: "equals", not_equals: "does not equal", contains: "contains", not_contains: "does not contain" } as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CONDITION_TRIGGERS = ["conversation_opened", "conversation_closed", "conversation_waiting", "template_button"];

export function TriggerForm({ flowId, state, onChange, lookups, hasToken }: { flowId: string; state: TriggerState; onChange: (next: TriggerState) => void; lookups: BuilderLookups; hasToken: boolean }) {
  const cfg = state.trigger_config;
  const setCfg = (patch: Record<string, unknown>) => onChange({ ...state, trigger_config: { ...cfg, ...patch } });
  const type = state.trigger_type;
  const conditions = (cfg.conditions as { logic?: "and" | "or"; conditions?: TriggerCondition[] } | undefined) ?? { logic: "and", conditions: [] };
  const list = conditions.conditions ?? [];
  const [token, setToken] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const setConditions = (next: TriggerCondition[], logic = conditions.logic ?? "and") => setCfg({ conditions: { logic, conditions: next } });

  return (
    <div className="flex flex-col gap-3">
      <TextField label="Flow name" value={state.name} onChange={(name) => onChange({ ...state, name })} />
      <TextField label="Description" value={state.description} onChange={(description) => onChange({ ...state, description })} placeholder="What this flow is for" />
      <SelectField label="Starts when" value={type} onChange={(t) => onChange({ ...state, trigger_type: t, trigger_config: t === "recurring" ? { cron: "0 9 * * *", timezone: "Asia/Dubai" } : {} })} options={TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGER_LABELS[t] ?? t }))} />
      <SelectField label="Number" value={state.channel_id ?? "all"} onChange={(v) => onChange({ ...state, channel_id: v === "all" ? null : v })} options={[{ value: "all", label: "All numbers" }, ...lookups.channels.map((c) => ({ value: c.id, label: c.name }))]} />

      {type === "template_button" && (
        <>
          <SelectField label="Template (optional)" value={String(cfg.template_id ?? "any")} onChange={(v) => setCfg({ template_id: v === "any" ? undefined : v })} options={[{ value: "any", label: "Any template" }, ...lookups.templates.map((t) => ({ value: t.id, label: t.name }))]} />
          <TextField label="Button text (optional)" value={String(cfg.button_text ?? "")} onChange={(v) => setCfg({ button_text: v || undefined })} placeholder="Book now" hint="Exact text of the quick-reply button the patient taps." />
        </>
      )}

      {CONDITION_TRIGGERS.includes(type) && (
        <Field label="Only when" hint="Leave empty to start for every match. Keyword is the patient's first message (or the tapped button).">
          <div className="flex flex-col gap-2">
            {list.length > 1 && <SelectField label="Match" value={conditions.logic ?? "and"} onChange={(l) => setConditions(list, l as "and" | "or")} options={[{ value: "and", label: "All conditions" }, { value: "or", label: "Any condition" }]} />}
            {list.map((c, i) => (
              <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2">
                <div className="flex gap-1.5">
                  <SelectField label="Category" value={c.category} onChange={(category) => setConditions(list.map((x, j) => (j === i ? { ...x, category: category as TriggerCondition["category"] } : x)))} options={CONDITION_CATEGORIES.map((k) => ({ value: k, label: CATEGORY_LABELS[k] }))} />
                  <SelectField label="Operator" value={c.op} onChange={(op) => setConditions(list.map((x, j) => (j === i ? { ...x, op: op as TriggerCondition["op"] } : x)))} options={CONDITION_OPS.map((o) => ({ value: o, label: OP_LABELS[o] }))} />
                </div>
                <Input aria-label={`Condition ${i + 1} value`} value={c.value} onChange={(e) => setConditions(list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Value" />
                <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => setConditions(list.filter((_, j) => j !== i))}>
                  <Trash2 /> Remove
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setConditions([...list, { category: "keyword", op: "contains", value: "" }])}>
              <Plus /> Add condition
            </Button>
          </div>
        </Field>
      )}

      {type === "recurring" && <RecurringForm cron={String(cfg.cron ?? "")} timezone={String(cfg.timezone ?? "Asia/Dubai")} segmentId={String(cfg.segment_id ?? "")} lookups={lookups} onChange={setCfg} />}

      {type === "webhook" && (
        <Field label="Incoming webhook" hint="POST JSON {phone | contact_id, first_name?, last_name?, data?} with the token as a Bearer header. Publish the flow to switch it on.">
          <div className="flex flex-col gap-2">
            <code className="bg-muted break-all rounded p-2 text-xs">POST {typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/in/{flowId}</code>
            {token && (
              <div className="flex items-center gap-1">
                <code className="bg-muted min-w-0 flex-1 truncate rounded p-2 text-xs">{token}</code>
                <Button type="button" variant="outline" size="icon-sm" aria-label="Copy token" onClick={() => navigator.clipboard.writeText(token).then(() => toast.success("Copied"))}>
                  <Copy />
                </Button>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await regenerateWebhookToken(flowId);
                  if (r.ok) {
                    setToken(r.data.token);
                    toast.success(r.message);
                  } else toast.error(r.error);
                })
              }
            >
              <KeyRound /> {hasToken || token ? "Rotate token" : "Create token"}
            </Button>
          </div>
        </Field>
      )}

      {type === "shortcut" && <p className="text-muted-foreground text-xs">Agents start this flow from the Shortcut button in the inbox composer.</p>}
      {["enquiry_added", "enquiry_stage_updated", "enquiry_status_updated", "appointment_created", "appointment_updated", "appointment_status_changed"].includes(type) && (
        <p className="text-muted-foreground text-xs">Starts when the event is raised. It becomes available as the Enquiries / Appointments modules are installed.</p>
      )}
    </div>
  );
}

function RecurringForm({ cron, timezone, segmentId, lookups, onChange }: { cron: string; timezone: string; segmentId: string; lookups: BuilderLookups; onChange: (patch: Record<string, unknown>) => void }) {
  const form = formFromCron(cron);
  const apply = (f: ScheduleForm) => {
    const c = cronFromForm(f);
    onChange({ cron: c ?? (f.freq === "custom" ? f.cron : cron) });
  };
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Repeats"
        value={form.freq}
        onChange={(freq) => apply(freq === "daily" ? { freq, time: "09:00" } : freq === "weekly" ? { freq, time: "09:00", weekday: 1 } : freq === "monthly" ? { freq, time: "09:00", day: 1 } : { freq: "custom", cron: cron || "0 9 * * *" })}
        options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "custom", label: "Custom (cron)" }]}
      />
      {form.freq !== "custom" && (
        <Field label="At">
          <Input type="time" value={form.time} onChange={(e) => apply({ ...form, time: e.target.value })} />
        </Field>
      )}
      {form.freq === "weekly" && <SelectField label="On" value={String(form.weekday)} onChange={(d) => apply({ ...form, weekday: Number(d) })} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />}
      {form.freq === "monthly" && <SelectField label="Day of month" value={String(form.day)} onChange={(d) => apply({ ...form, day: Number(d) })} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} hint="Days 29–31 are not offered so no month is skipped." />}
      {form.freq === "custom" && <TextField label="Cron expression" value={form.cron} onChange={(c) => onChange({ cron: c })} mono hint="minute hour day-of-month month day-of-week" />}
      <TextField label="Timezone" value={timezone} onChange={(timezone) => onChange({ timezone })} mono />
      <SelectField label="For" value={segmentId || "none"} onChange={(v) => onChange({ segment_id: v === "none" ? undefined : v })} options={[{ value: "none", label: "No contact (one run)" }, ...lookups.segments.map((s) => ({ value: s.id, label: `Every contact in "${s.name}"` }))]} hint="With a segment the flow starts once per member (up to 200 per tick)." />
      <p className="text-muted-foreground text-xs">{describeSchedule(form)}</p>
    </div>
  );
}
