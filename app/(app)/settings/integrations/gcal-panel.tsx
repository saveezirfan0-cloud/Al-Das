"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { disconnectGoogleCalendar, startGoogleCalendarConnect } from "./gcal-actions";

export type GcalRow = {
  specialistId: string;
  name: string;
  status: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
};

const RESULT: Record<string, string> = {
  connected: "Calendar connected. The first sync runs within five minutes.",
  denied: "Google access was not granted.",
  failed: "The connection did not complete. Start again.",
  invalid: "The answer from Google was not valid. Start again.",
  forbidden: "You need the doctor calendars permission.",
  busy: "Too many attempts. Wait a few minutes.",
};

/** One row per doctor: connect (sends the browser to Google), disconnect, and when the last sync happened. */
export function GcalPanel({
  enabled,
  rows,
  redirectUri,
  result,
}: {
  enabled: boolean;
  rows: GcalRow[];
  redirectUri: string;
  result: string | null;
}) {
  const [pending, start] = useTransition();

  function connect(specialistId: string) {
    start(async () => {
      const r = await startGoogleCalendarConnect({ specialistId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.url && r.url.startsWith("https://accounts.google.com/")) window.location.assign(r.url);
    });
  }

  function remove(specialistId: string, name: string) {
    if (
      !window.confirm(
        `Disconnect ${name}'s Google Calendar? Pulse will stop reading and writing it.`,
      )
    )
      return;
    start(async () => {
      const r = await disconnectGoogleCalendar({ specialistId });
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Doctors&apos; calendars</CardTitle>
        <CardDescription>
          Connect each doctor&apos;s own Google Calendar. The doctor signs in to Google on this
          device to allow it. Busy times come in as blocked time (without their titles) and Pulse
          appointments go out as &lsquo;Busy&rsquo; with no patient detail.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {result && RESULT[result] && (
          <p className="text-sm" role="status">
            {RESULT[result]}
          </p>
        )}
        {!enabled && (
          <p className="text-muted-foreground text-sm">
            Switch the integration on (above) before connecting calendars.
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          In the Google Cloud console, add this authorised redirect address to the OAuth client:{" "}
          <code className="bg-muted rounded px-1">{redirectUri}</code>
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Doctor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.specialistId}>
                <TableCell>{r.name}</TableCell>
                <TableCell>
                  {r.status === null ? (
                    <Badge variant="outline">Not connected</Badge>
                  ) : r.status === "active" ? (
                    <Badge variant="success">Connected</Badge>
                  ) : (
                    <Badge variant="warning" title={r.lastError ?? undefined}>
                      Problem
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {r.lastPushAt ? new Date(r.lastPushAt).toLocaleString() : "Never"}
                  {r.lastError && r.status !== "active" ? ` · ${r.lastError}` : ""}
                </TableCell>
                <TableCell className="text-right">
                  {r.status === null ? (
                    <Button
                      size="sm"
                      disabled={pending || !enabled}
                      onClick={() => connect(r.specialistId)}
                    >
                      {pending ? <Loader2 className="animate-spin" /> : null} Connect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => remove(r.specialistId, r.name)}
                    >
                      Disconnect
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-sm">
                  No active doctors.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
