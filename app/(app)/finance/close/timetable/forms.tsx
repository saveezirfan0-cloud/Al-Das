"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { WEEKDAY_LABELS } from "@/lib/finance/close-timetable";

import {
  addHoliday,
  createCloseTasks,
  deleteHoliday,
  saveCloseCalendar,
  saveCloseStep,
  setCloseTaskStatus,
} from "./actions";

export type Person = { id: string; name: string };

export type StepView = {
  code: string;
  title: string;
  ownerRole: string | null;
  ownerUserId: string | null;
  backupUserId: string | null;
  dueWd: number;
  dependsOn: string[];
  evidenceHint: string | null;
  active: boolean;
  sortOrder: number;
};

const Check = ({ name, label, checked }: { name: string; label: string; checked: boolean }) => (
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" name={name} defaultChecked={checked} /> {label}
  </label>
);

export function TaskUpdateButton({
  id,
  title,
  status,
  reason,
  note,
}: {
  id: string;
  title: string;
  status: string;
  reason: string | null;
  note: string | null;
}) {
  const [choice, setChoice] = React.useState(status);
  return (
    <FormSheet trigger="Update" title={title} variant="outline" size="sm">
      {(close) => (
        <ActionForm action={setCloseTaskStatus} submitLabel="Save" onDone={close}>
          <input type="hidden" name="id" value={id} />
          <Field label="Status">
            <select
              name="status"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className={selectClass}
            >
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="blocked">Blocked</option>
            </select>
          </Field>
          {choice === "blocked" && (
            <Field
              label="Waiting for"
              hint="Name the dependency: who or what this step is waiting for, so the date can be judged."
            >
              <Input name="reason" defaultValue={reason ?? ""} maxLength={300} required />
            </Field>
          )}
          <Field
            label="Note (optional)"
            hint="Where the evidence is, or anything the reviewer should know."
          >
            <Input name="note" defaultValue={note ?? ""} maxLength={500} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function CreateTasksButton({ month }: { month: string }) {
  return (
    <RunButton variant="default" action={() => createCloseTasks({ month })}>
      Create this month&apos;s steps
    </RunButton>
  );
}

function PersonSelect({
  name,
  value,
  people,
}: {
  name: string;
  value: string | null;
  people: Person[];
}) {
  return (
    <select name={name} defaultValue={value ?? ""} className={selectClass}>
      <option value="">Nobody yet</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function StepButton({
  step,
  steps,
  people,
}: {
  step?: StepView;
  steps: { code: string; title: string }[];
  people: Person[];
}) {
  const others = steps.filter((s) => s.code !== step?.code);
  return (
    <FormSheet
      trigger={step ? "Edit" : "Add step"}
      title={step ? `Edit ${step.title}` : "Add a close step"}
      description="Owners and backups need the close timetable permission to mark their steps. A changed due day applies to months whose steps are created from now on."
      variant={step ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveCloseStep} submitLabel="Save step" onDone={close}>
          <Field label="Code" hint="Capital letters, digits or _ (for example BANK_CASH).">
            <Input
              name="code"
              defaultValue={step?.code ?? ""}
              readOnly={!!step}
              maxLength={24}
              required
            />
          </Field>
          <Field label="Title">
            <Input name="title" defaultValue={step?.title ?? ""} maxLength={120} required />
          </Field>
          <Field
            label="Due on working day"
            hint="Counted in the month after the month being closed (1 to 23)."
          >
            <Input name="due_wd" inputMode="numeric" defaultValue={step?.dueWd ?? 5} required />
          </Field>
          <Field label="Owner">
            <PersonSelect name="owner_user_id" value={step?.ownerUserId ?? null} people={people} />
          </Field>
          <Field label="Trained backup">
            <PersonSelect
              name="backup_user_id"
              value={step?.backupUserId ?? null}
              people={people}
            />
          </Field>
          <Field label="Owner's role (shown when nobody is assigned)">
            <Input name="owner_role" defaultValue={step?.ownerRole ?? ""} maxLength={60} />
          </Field>
          <Field label="Evidence" hint="What shows the step is done.">
            <Input name="evidence_hint" defaultValue={step?.evidenceHint ?? ""} maxLength={200} />
          </Field>
          {others.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium">Depends on</legend>
              {others.map((o) => (
                <Check
                  key={o.code}
                  name={`dep_${o.code}`}
                  label={o.title}
                  checked={step?.dependsOn.includes(o.code) ?? false}
                />
              ))}
            </fieldset>
          )}
          <Field label="Order">
            <Input name="sort_order" inputMode="numeric" defaultValue={step?.sortOrder ?? 100} />
          </Field>
          <Check
            name="active"
            label="Active (inactive steps are not added to new months)"
            checked={step?.active ?? true}
          />
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function CalendarForm({
  start,
  weekend,
  inputsWd,
  deadlineWd,
  deadlineDay,
  itemMaxAgeDays,
  revshareWd,
  voucherUnpaidDays,
  receivablesOver90Pct,
}: {
  start: string | null;
  weekend: number[];
  inputsWd: number;
  deadlineWd: number;
  deadlineDay: number | null;
  itemMaxAgeDays: number;
  revshareWd: number;
  voucherUnpaidDays: number;
  receivablesOver90Pct: number;
}) {
  return (
    <ActionForm action={saveCloseCalendar} submitLabel="Save">
      <Field
        label="Run the timetable from (close month)"
        hint="Blank = off. From this month on, the daily job adds each month's steps on working day 1 and reminds owners of steps due or overdue."
        className="max-w-xs"
      >
        <Input type="month" name="start" defaultValue={start?.slice(0, 7) ?? ""} />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Weekend days</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <Check
              key={d}
              name={`wk_${d}`}
              label={WEEKDAY_LABELS[d]}
              checked={weekend.includes(d)}
            />
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Inputs due by working day">
          <Input name="inputs_wd" inputMode="numeric" defaultValue={inputsWd} />
        </Field>
        <Field label="Final pack due by working day">
          <Input name="deadline_wd" inputMode="numeric" defaultValue={deadlineWd} />
        </Field>
        <Field
          label="Or by this day of the month"
          hint="1 to 28. When set, the close is due on this calendar day instead of the working day (agreed 16 Oct 2026: the 10th)."
        >
          <Input name="deadline_day" inputMode="numeric" defaultValue={deadlineDay ?? ""} />
        </Field>
        <Field label="Reconciling items: age limit (days)">
          <Input name="item_max_age_days" inputMode="numeric" defaultValue={itemMaxAgeDays} />
        </Field>
      </div>
      <div className="text-sm font-medium">Board pack: matters needing attention</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Revenue shares approved by working day">
          <Input name="revshare_wd" inputMode="numeric" defaultValue={revshareWd} />
        </Field>
        <Field label="Approved vouchers unpaid after (days)">
          <Input name="voucher_unpaid_days" inputMode="numeric" defaultValue={voucherUnpaidDays} />
        </Field>
        <Field label="Insurance receivables over 90 days: limit (%)">
          <Input
            name="receivables_over90_pct"
            inputMode="decimal"
            defaultValue={receivablesOver90Pct}
          />
        </Field>
      </div>
    </ActionForm>
  );
}

export function HolidayForm() {
  return (
    <ActionForm action={addHoliday} submitLabel="Add holiday" variant="outline">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Date">
          <Input type="date" name="holiday_on" required />
        </Field>
        <Field label="Name">
          <Input name="name" maxLength={80} required />
        </Field>
      </div>
    </ActionForm>
  );
}

export function DeleteHolidayButton({ id }: { id: string }) {
  return (
    <RunButton variant="ghost" confirm="Remove this holiday?" action={() => deleteHoliday({ id })}>
      Remove
    </RunButton>
  );
}
