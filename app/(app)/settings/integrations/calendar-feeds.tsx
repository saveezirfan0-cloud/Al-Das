"use client";

import { useState, useTransition } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  createCalendarFeed,
  revokeCalendarFeed,
  rotateCalendarFeed,
  type FeedActionResult,
} from "./calendar-actions";

type Feed = {
  id: string;
  kind: string;
  label: string;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
  last_access_at: string | null;
  access_count: number;
  specialistName: string | null;
  userName: string | null;
};

export function CalendarFeeds({
  enabled,
  feeds,
  specialists,
  people,
  selfId,
  canSeeEveryone,
}: {
  enabled: boolean;
  feeds: Feed[];
  specialists: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  selfId: string;
  canSeeEveryone: boolean;
}) {
  const [pending, start] = useTransition();
  const [target, setTarget] = useState<string>("");
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<{ url: string; label: string } | null>(null);

  function run(fn: () => Promise<FeedActionResult>, label: string) {
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.message);
      if (r.url) setShown({ url: r.url, label });
    });
  }

  function create() {
    const [kind, id] = target.split(":");
    if (!kind || !id) return void toast.error("Choose a doctor or a person.");
    run(
      () =>
        createCalendarFeed({
          label,
          target:
            kind === "specialist"
              ? { kind: "specialist", specialistId: id }
              : { kind: "user", userId: id },
        }),
      label,
    );
    setLabel("");
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy. Select the link and copy it by hand.");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {!enabled && (
        <Alert>
          <AlertTitle>Calendar feeds are switched off</AlertTitle>
          <AlertDescription>
            An administrator can switch them on above. Existing links stop working while it is off.
          </AlertDescription>
        </Alert>
      )}

      {shown && (
        <Alert>
          <AlertTitle>Copy the link for {shown.label} now</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              It is shown only once. Add it in Outlook, Google Calendar or Apple Calendar as a
              subscribed calendar. Anyone with the link can see appointment times, so share it with
              the doctor only.
            </span>
            <code className="bg-muted block overflow-x-auto rounded px-2 py-1 text-xs">
              {shown.url}
            </code>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => copy(shown.url)}>
                <Copy /> Copy
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShown(null)}>
                I have copied it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New feed</CardTitle>
          <CardDescription>
            A feed shows when a doctor is booked and the clinic location, as
            &ldquo;Appointment&rdquo;. It never shows patient names, phone numbers, notes or
            services. The last 7 days and the next 60 are included.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid max-w-sm gap-1">
            <Label htmlFor="feed-target">Whose appointments</Label>
            <select
              id="feed-target"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose…</option>
              <option value={`user:${selfId}`}>My appointments (my doctor profile)</option>
              <optgroup label="A doctor">
                {specialists.map((s) => (
                  <option key={s.id} value={`specialist:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
              {canSeeEveryone && (
                <optgroup label="A colleague's appointments">
                  {people
                    .filter((p) => p.id !== selfId)
                    .map((p) => (
                      <option key={p.id} value={`user:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="grid max-w-sm gap-1">
            <Label htmlFor="feed-label">Calendar name</Label>
            <Input
              id="feed-label"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Dr Amal, Clinic appointments"
            />
          </div>
          <div>
            <Button disabled={pending || !enabled || !label.trim() || !target} onClick={create}>
              {pending && <Loader2 className="animate-spin" />} Create feed
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Feeds</CardTitle>
          <CardDescription>
            Rotate a link if it may have been shared by mistake: the old link stops working at once.
            Fetch counts are totals, not a record of who looked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {feeds.length === 0 ? (
            <p className="text-muted-foreground text-sm">No feeds yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Fetches</TableHead>
                  <TableHead>Last fetched</TableHead>
                  <TableHead className="w-48" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {feeds.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>{f.label}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {f.kind === "specialist"
                        ? (f.specialistName ?? "Doctor")
                        : `${f.userName ?? "Person"} (all their doctor profiles)`}
                    </TableCell>
                    <TableCell>
                      {f.revoked_at ? (
                        <Badge variant="outline">Revoked</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{f.access_count}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {f.last_access_at ? new Date(f.last_access_at).toLocaleString() : "Never"}
                    </TableCell>
                    <TableCell className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || !enabled}
                        onClick={() => run(() => rotateCalendarFeed({ id: f.id }), f.label)}
                      >
                        Rotate
                      </Button>
                      {!f.revoked_at && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => run(() => revokeCalendarFeed({ id: f.id }), f.label)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
