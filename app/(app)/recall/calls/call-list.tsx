"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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

import { updateFollowUp } from "../actions";

export type CallRow = {
  id: string;
  contactId: string;
  patient: string;
  programme: string;
  sentAt: string;
  daysWaiting: number;
  overdue: boolean;
  status: "called" | "no_response" | "booked" | null;
};

export function CallList({ rows, canEdit }: { rows: CallRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
        Nobody to call right now.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Patient</TableHead>
          <TableHead>Programme</TableHead>
          <TableHead>Messaged</TableHead>
          <TableHead>Waiting</TableHead>
          <TableHead>Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link
                href={`/contacts?contact=${r.contactId}`}
                className="font-medium hover:underline"
              >
                {r.patient}
              </Link>
              {r.overdue && (
                <Badge variant="secondary" className="ml-2 bg-amber-100 text-amber-800">
                  Overdue
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-sm">{r.programme}</TableCell>
            <TableCell className="text-sm">
              {new Date(r.sentAt).toLocaleDateString("en-GB", {
                timeZone: "Asia/Dubai",
                dateStyle: "medium",
              })}
            </TableCell>
            <TableCell className="tabular-nums">{r.daysWaiting} days</TableCell>
            <TableCell>
              <Select
                value={r.status ?? "none"}
                disabled={!canEdit || pending}
                onValueChange={(v) =>
                  startTransition(async () => {
                    const res = await updateFollowUp({
                      id: r.id,
                      follow_up_status:
                        v === "none" ? null : (v as "called" | "no_response" | "booked"),
                    });
                    if (res.ok) router.refresh();
                    else toast.error(res.error);
                  })
                }
              >
                <SelectTrigger aria-label={`Outcome for ${r.patient}`} className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">To call</SelectItem>
                  <SelectItem value="called">Called</SelectItem>
                  <SelectItem value="no_response">No response</SelectItem>
                  <SelectItem value="booked">Booked</SelectItem>
                </SelectContent>
              </Select>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
