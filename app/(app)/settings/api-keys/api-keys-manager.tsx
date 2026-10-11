"use client";

import { useState, useTransition } from "react";
import { Check, ClipboardCopy, KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API_KEY_SCOPES, SCOPE_LABELS, type ApiKeyScope } from "@/lib/public-api/scopes";

import { createApiKey, revokeApiKey } from "./actions";

type KeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

const EXPIRY = [
  { value: "never", label: "Never expires", days: null },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
] as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Never");

function status(k: KeyRow): { label: string; variant: "success" | "destructive" | "warning" } {
  if (k.revoked_at) return { label: "Revoked", variant: "destructive" };
  if (k.expires_at && new Date(k.expires_at) <= new Date()) return { label: "Expired", variant: "warning" };
  return { label: "Active", variant: "success" };
}

export function ApiKeysManager({ keys, baseUrl }: { keys: KeyRow[]; baseUrl: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["contacts:read"]);
  const [expiry, setExpiry] = useState<string>("90");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await createApiKey({ name, scopes, expires_in_days: EXPIRY.find((x) => x.value === expiry)?.days ?? null });
      if (!r.ok) return setError(r.error);
      setOpen(false);
      setName("");
      setCreated(r.data.key);
      setCopied(false);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus /> New key
        </Button>
      </div>

      {keys.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">No API keys yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => {
              const s = status(k);
              return (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.key_prefix}…</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((sc) => (
                        <Badge key={sc} variant="outline">
                          {sc}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{when(k.last_used_at)}</TableCell>
                  <TableCell className="text-sm">{k.expires_at ? when(k.expires_at) : "Never"}</TableCell>
                  <TableCell>
                    <Badge variant={s.variant}>{s.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revoked_at && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          if (!confirm(`Revoke “${k.name}”? Systems using it will stop working immediately.`)) return;
                          start(async () => {
                            const r = await revokeApiKey(k.id);
                            if (r.ok) toast.success(r.message);
                            else toast.error(r.error);
                          });
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Using the API</CardTitle>
          <CardDescription>
            Base URL <code>{baseUrl}</code>. Send the key as <code>Authorization: Bearer &lt;key&gt;</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{`# list contacts
curl ${baseUrl}/contacts?limit=20 \\
  -H "Authorization: Bearer $PULSE_API_KEY"

# send an approved template (Idempotency-Key makes retries safe)
curl -X POST ${baseUrl}/send-template \\
  -H "Authorization: Bearer $PULSE_API_KEY" \\
  -H "Idempotency-Key: appt-reminder-1042" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"+971501234567","template":"appointment_reminder","language":"en","variables":{"body.1":"Amal","body.2":"Tuesday 10:00"}}'`}</pre>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Give it only the permissions the system needs.</DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Booking system" maxLength={80} />
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Permissions</legend>
              {API_KEY_SCOPES.map((sc) => (
                <label key={sc} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={scopes.includes(sc)}
                    onCheckedChange={(v) => setScopes((cur) => (v ? [...cur, sc] : cur.filter((x) => x !== sc)))}
                    className="mt-0.5"
                  />
                  <span>
                    {SCOPE_LABELS[sc].label} <code className="text-muted-foreground text-xs">{sc}</code>
                    <span className="text-muted-foreground block text-xs">{SCOPE_LABELS[sc].description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-2">
              <Label>Expires</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY.map((x) => (
                    <SelectItem key={x.value} value={x.value}>
                      {x.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                {pending && <Loader2 className="animate-spin" />} Create key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> Copy your key now
            </DialogTitle>
            <DialogDescription>This is the only time it is shown. It cannot be recovered; if lost, revoke it and create a new one.</DialogDescription>
          </DialogHeader>
          <div className="bg-muted flex items-center gap-2 rounded-md p-2">
            <code className="min-w-0 flex-1 text-xs break-all" data-testid="new-api-key">
              {created}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (created) void navigator.clipboard.writeText(created).then(() => setCopied(true));
              }}
            >
              {copied ? <Check /> : <ClipboardCopy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Alert>
            <AlertTitle>Keep it secret</AlertTitle>
            <AlertDescription>Store it in your system&apos;s secret manager, never in code or chat.</AlertDescription>
          </Alert>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>I&apos;ve saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
