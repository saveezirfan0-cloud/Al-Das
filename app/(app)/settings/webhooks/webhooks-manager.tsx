"use client";

import { useState, useTransition } from "react";
import { Check, ClipboardCopy, Loader2, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { createWebhook, deleteWebhook, retryDelivery, rotateWebhookSecret, sendTestWebhook, setWebhookActive, type SecretResult } from "./actions";

type Sub = { id: string; url: string; host: string; description: string | null; events: string[]; active: boolean };
type Delivery = {
  id: string;
  host: string;
  event: string;
  status: string;
  attempts: number;
  response_code: number | null;
  error: string | null;
  created_at: string;
  next_attempt_at: string | null;
};

const STATUS: Record<string, "success" | "warning" | "destructive" | "secondary"> = { success: "success", failed: "warning", dead: "destructive", pending: "secondary" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" });

export function WebhooksManager({ subs, deliveries, events }: { subs: Sub[]; deliveries: Delivery[]; events: Array<{ name: string; label: string; description: string }> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>(["message.received"]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  function reveal(r: SecretResult) {
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    setSecret(r.data.secret);
    setCopied(false);
  }

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message ?? "Done.");
      else toast.error(r.error ?? "Something went wrong.");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus /> New endpoint
        </Button>
      </div>

      {subs.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">No endpoints yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {subs.map((s) => (
            <li key={s.id} className="bg-card flex flex-col gap-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.host}</div>
                  <div className="text-muted-foreground truncate text-xs">{s.description || s.url}</div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={s.active} disabled={pending} onCheckedChange={(v) => act(() => setWebhookActive(s.id, v))} aria-label={`Enable ${s.host}`} />
                  {s.active ? "Active" : "Paused"}
                </label>
                <Button variant="outline" size="sm" disabled={pending} onClick={() => act(() => sendTestWebhook(s.id))}>
                  <Send /> Send test
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    if (confirm("Rotate the signing secret? The old one stops working immediately.")) start(async () => {
                      reveal(await rotateWebhookSecret(s.id));
                    });
                  }}
                >
                  <RefreshCw /> Rotate secret
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${s.host}`}
                  disabled={pending}
                  onClick={() => {
                    if (confirm(`Delete the endpoint ${s.host} and its delivery log?`)) act(() => deleteWebhook(s.id));
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {s.events.map((e) => (
                  <Badge key={e} variant="outline">
                    {e}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery log</CardTitle>
          <CardDescription>The last 50 deliveries. Failed ones are retried after 1 min, 5 min, 30 min, 2 h and 6 h, then marked dead.</CardDescription>
        </CardHeader>
        <CardContent>
          {deliveries.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing delivered yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Tries</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs whitespace-nowrap">{when(d.created_at)}</TableCell>
                    <TableCell className="text-xs">{d.host}</TableCell>
                    <TableCell className="font-mono text-xs">{d.event}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS[d.status] ?? "secondary"}>{d.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{d.attempts}</TableCell>
                    <TableCell className="text-muted-foreground max-w-56 truncate text-xs" title={d.error ?? undefined}>
                      {d.response_code ? `HTTP ${d.response_code}` : ""} {d.error && d.error !== `HTTP ${d.response_code}` ? d.error : ""}
                      {d.status === "failed" && d.next_attempt_at ? ` Next try ${when(d.next_attempt_at)}.` : ""}
                    </TableCell>
                    <TableCell>
                      {(d.status === "failed" || d.status === "dead") && (
                        <Button variant="ghost" size="xs" disabled={pending} onClick={() => act(() => retryDelivery(d.id))}>
                          Retry
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Verifying a request</CardTitle>
          <CardDescription>
            Each request has <code>X-Pulse-Signature: t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>, where the HMAC-SHA256 of <code>&lt;t&gt;.&lt;raw body&gt;</code> uses your secret. Reject signatures more than 5 minutes old.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, header) {
  const p = Object.fromEntries(header.split(",").map((x) => x.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(p.t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(p.t + "." + rawBody).digest();
  const given = Buffer.from(p.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}`}</pre>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New webhook endpoint</DialogTitle>
            <DialogDescription>Must be a public https:// address.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              start(async () => {
                const r = await createWebhook({ url, description, events: selected });
                if (!r.ok) return setError(r.error);
                setOpen(false);
                setUrl("");
                setDescription("");
                reveal(r);
              });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="wh-url">Endpoint URL</Label>
              <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/pulse-webhook" inputMode="url" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wh-desc">Description (optional)</Label>
              <Input id="wh-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
            </div>
            <div className="grid gap-2">
              <Label>Events</Label>
              <MultiSelect options={events.map((e) => ({ value: e.name, label: e.label, hint: e.description }))} value={selected} onChange={setSelected} placeholder="Pick events" />
            </div>
            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />} Create endpoint
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={secret !== null} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy the signing secret now</DialogTitle>
            <DialogDescription>It is shown only once. Use it to verify the signature on every request.</DialogDescription>
          </DialogHeader>
          <div className="bg-muted flex items-center gap-2 rounded-md p-2">
            <code className="min-w-0 flex-1 text-xs break-all">{secret}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (secret) void navigator.clipboard.writeText(secret).then(() => setCopied(true));
              }}
            >
              {copied ? <Check /> : <ClipboardCopy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Alert>
            <AlertTitle>Lost it?</AlertTitle>
            <AlertDescription>Use “Rotate secret” on the endpoint to issue a new one.</AlertDescription>
          </Alert>
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>I&apos;ve saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
