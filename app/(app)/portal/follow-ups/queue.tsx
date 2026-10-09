"use client";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { notifyDoctor, updateFollowUp } from "./actions";

export type FollowUpRow = {
  id: string;
  ref: string | null;
  patient: string;
  phone: string | null;
  priority: string;
  dueDate: string | null;
  category: string | null;
  rulesFired: string[];
  department: string | null;
  doctor: string | null;
  visitDate: string | null;
  ageAtVisit: number | null;
  callStatus: string;
  outcome: string | null;
  escalationStatus: string;
  doctorNotified: boolean;
  doctorAlert: boolean;
  doctorResponseNotes: string | null;
  notes: string | null;
  assignedUserId: string | null;
  source: string;
  isTest: boolean;
  vitals: {
    temp: number | null;
    bp: string | null;
    spo2: number | null;
    pulse: number | null;
  } | null;
  script: string | null;
};

const CALL_STATUS = ["pending", "completed", "escalated", "no_answer"] as const;
const OUTCOMES = ["improving", "same", "worse"] as const;
const ESCALATION = ["none", "open", "escalated", "resolved"] as const;
const label = (s: string) => s.replace(/_/g, " ");

const selectCls =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm disabled:opacity-50";

export function FollowUpQueue({
  items,
  members,
  canWrite,
  today,
}: {
  items: FollowUpRow[];
  members: Array<{ id: string; name: string }>;
  canWrite: boolean;
  today: string;
}) {
  const [priority, setPriority] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const shown = items.filter(
    (i) =>
      (priority === "all" || i.priority === priority) &&
      (status === "all" || i.callStatus === status) &&
      (!overdueOnly || (i.dueDate !== null && i.dueDate < today)),
  );
  const open = items.find((i) => i.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={cn(selectCls, "w-36")}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          aria-label="Priority"
        >
          <option value="all">All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
        </select>
        <select
          className={cn(selectCls, "w-40")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Call status"
        >
          <option value="all">All call statuses</option>
          {CALL_STATUS.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          Overdue only
        </label>
        <span className="text-muted-foreground ml-auto text-xs">
          {shown.length} of {items.length} open
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs">
            <tr>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Rules</th>
              <th className="px-3 py-2">Department</th>
              <th className="px-3 py-2">Call</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted-foreground px-3 py-8 text-center">
                  Nothing to follow up.
                </td>
              </tr>
            )}
            {shown.map((i) => {
              const overdue = i.dueDate !== null && i.dueDate < today;
              return (
                <tr
                  key={i.id}
                  className="hover:bg-accent/40 cursor-pointer"
                  onClick={() => setOpenId(i.id)}
                >
                  <td className="px-3 py-2">
                    <Badge variant={i.priority === "high" ? "destructive" : "secondary"}>
                      {i.priority}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {i.patient}
                    {i.isTest && (
                      <Badge variant="outline" className="ml-2">
                        test
                      </Badge>
                    )}
                  </td>
                  <td className={cn("px-3 py-2", overdue && "font-medium text-red-600")}>
                    {i.dueDate ?? "—"}
                    {overdue && " (overdue)"}
                  </td>
                  <td className="px-3 py-2">{i.category ? label(i.category) : label(i.source)}</td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {i.rulesFired.join(", ") || "—"}
                  </td>
                  <td className="px-3 py-2">{i.department ?? "undetermined"}</td>
                  <td className="px-3 py-2">{label(i.callStatus)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          {open && (
            <FollowUpDrawer
              key={open.id}
              item={open}
              members={members}
              canWrite={canWrite}
              onDone={() => setOpenId(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FollowUpDrawer({
  item,
  members,
  canWrite,
  onDone,
}: {
  item: FollowUpRow;
  members: Array<{ id: string; name: string }>;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [callStatus, setCallStatus] = React.useState(item.callStatus);
  const [outcome, setOutcome] = React.useState(item.outcome ?? "");
  const [escalation, setEscalation] = React.useState(item.escalationStatus);
  const [assignee, setAssignee] = React.useState(item.assignedUserId ?? "");
  const [doctorNotes, setDoctorNotes] = React.useState(item.doctorResponseNotes ?? "");
  const [notes, setNotes] = React.useState(item.notes ?? "");

  function save(close: boolean) {
    startTransition(async () => {
      const res = await updateFollowUp({
        id: item.id,
        callStatus: callStatus as (typeof CALL_STATUS)[number],
        outcome: (outcome || null) as (typeof OUTCOMES)[number] | null,
        escalationStatus: escalation as (typeof ESCALATION)[number],
        doctorResponseNotes: doctorNotes || null,
        notes: notes || null,
        assignedUserId: assignee || null,
        close,
      });
      if (res.ok) {
        toast.success(res.message);
        if (close) onDone();
      } else toast.error(res.error);
    });
  }

  function ping() {
    startTransition(async () => {
      const res = await notifyDoctor(item.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{item.patient}</SheetTitle>
        <SheetDescription>
          {[
            item.phone,
            item.ageAtVisit !== null && `age ${item.ageAtVisit}`,
            item.visitDate && `visit ${item.visitDate}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4 pb-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={item.priority === "high" ? "destructive" : "secondary"}>
            {item.priority}
          </Badge>
          {item.category && <Badge variant="outline">{label(item.category)}</Badge>}
          {item.doctorAlert && <Badge variant="destructive">doctor alert</Badge>}
          {item.doctor && <Badge variant="outline">{item.doctor}</Badge>}
        </div>

        {item.vitals && (
          <dl className="grid grid-cols-4 gap-2 rounded-md border p-3 text-xs">
            {(
              [
                ["Temp °C", item.vitals.temp],
                ["BP", item.vitals.bp],
                ["SpO₂ %", item.vitals.spo2],
                ["Pulse", item.vitals.pulse],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v ?? "—"}</dd>
              </div>
            ))}
          </dl>
        )}

        {item.rulesFired.length > 0 && (
          <p className="text-muted-foreground text-xs">Rules fired: {item.rulesFired.join(", ")}</p>
        )}

        {item.script ? (
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground mb-1 text-xs font-medium">Call script (approved)</p>
            <p className="whitespace-pre-wrap">{item.script}</p>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            No clinically approved call script for this category yet. Follow the clinic&apos;s
            current protocol.
          </p>
        )}

        <fieldset disabled={!canWrite || pending} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="fu-call">Call status</Label>
              <select
                id="fu-call"
                className={selectCls}
                value={callStatus}
                onChange={(e) => setCallStatus(e.target.value)}
              >
                {CALL_STATUS.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="fu-outcome">Patient is</Label>
              <select
                id="fu-outcome"
                className={selectCls}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="">Not recorded</option>
                {OUTCOMES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="fu-esc">Escalation</Label>
              <select
                id="fu-esc"
                className={selectCls}
                value={escalation}
                onChange={(e) => setEscalation(e.target.value)}
              >
                {ESCALATION.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="fu-assignee">Assigned to</Label>
              <select
                id="fu-assignee"
                className={selectCls}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fu-doc">Doctor response</Label>
            <Textarea
              id="fu-doc"
              rows={2}
              value={doctorNotes}
              onChange={(e) => setDoctorNotes(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fu-notes">Notes</Label>
            <Textarea
              id="fu-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </fieldset>
        <p className="text-muted-foreground text-xs">
          {item.doctorNotified ? "Doctor has been notified." : "Doctor not yet notified."}
        </p>
      </div>

      {canWrite && (
        <SheetFooter className="flex-row flex-wrap justify-between gap-2">
          <Button variant="outline" disabled={pending} onClick={ping}>
            Notify doctor
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={pending} onClick={() => save(false)}>
              Save
            </Button>
            <Button disabled={pending} onClick={() => save(true)}>
              Save &amp; close
            </Button>
          </div>
        </SheetFooter>
      )}
    </>
  );
}
