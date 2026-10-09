"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { updateRecallFollowUp } from "../actions";

export type CallRowData = {
  id: string;
  patient: string;
  programme: string;
  segment: string | null;
  sentOn: string;
  workdays: number;
  overdue: boolean;
  followUp: string | null;
  assignee: string | null;
  outcome: string;
};

const NONE = "__none__";

export function CallList({
  rows,
  people,
  canEdit,
  thresholdSigned,
}: {
  rows: CallRowData[];
  people: Array<{ id: string; name: string }>;
  canEdit: boolean;
  thresholdSigned: boolean;
}) {
  const router = useRouter();
  async function save(id: string, patch: Parameters<typeof updateRecallFollowUp>[1]) {
    const r = await updateRecallFollowUp(id, patch);
    if (!r.ok) return void toast.error(r.error);
    router.refresh();
  }
  return (
    <div className="space-y-3">
      {!thresholdSigned ? (
        <Alert variant="destructive">
          <AlertDescription>
            The number of working days before a call is not signed off in Clinical settings, so
            nobody is listed.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Patient</TableHead>
              <TableHead>Recall</TableHead>
              <TableHead>Waiting</TableHead>
              <TableHead>Call result</TableHead>
              <TableHead>Assigned to</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                  Nobody is waiting for a call.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.patient}</TableCell>
                  <TableCell>
                    <div>{r.programme}</div>
                    <div className="text-muted-foreground text-xs capitalize">
                      {r.segment?.replaceAll("_", " ")} · sent {r.sentOn}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">{r.workdays} working days</span>{" "}
                    {r.overdue ? <Badge variant="destructive">overdue</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <Select
                      disabled={!canEdit}
                      value={r.followUp ?? NONE}
                      onValueChange={(v) =>
                        save(r.id, {
                          follow_up_status:
                            v === NONE ? null : (v as "called" | "no_response" | "booked"),
                        })
                      }
                    >
                      <SelectTrigger
                        className="h-8 w-36"
                        aria-label={`Call result for ${r.patient}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not called yet</SelectItem>
                        <SelectItem value="called">Called</SelectItem>
                        <SelectItem value="no_response">No answer</SelectItem>
                        <SelectItem value="booked">Booked</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      disabled={!canEdit}
                      value={r.assignee ?? NONE}
                      onValueChange={(v) => save(r.id, { assigned_user_id: v === NONE ? null : v })}
                    >
                      <SelectTrigger className="h-8 w-40" aria-label={`Assignee for ${r.patient}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Unassigned</SelectItem>
                        {people.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Note for ${r.patient}`}
                      className="h-8 w-44"
                      defaultValue={r.outcome}
                      maxLength={80}
                      disabled={!canEdit}
                      placeholder="e.g. wants a visit"
                      onBlur={(e) =>
                        e.target.value !== r.outcome && save(r.id, { outcome: e.target.value })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
