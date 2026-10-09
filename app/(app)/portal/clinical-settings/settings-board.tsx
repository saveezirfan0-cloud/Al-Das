"use client";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CONFIRM_PHRASE, isGuardedKey } from "@/lib/clinical/sign-off";

import {
  loadSettingHistory,
  revokeSetting,
  signOffSetting,
  updateSettingMeta,
  type HistoryEntry,
} from "./actions";

export type SettingItem = {
  key: string;
  label: string;
  category: string;
  valueType: string;
  proposed: string | null;
  approved: string | null;
  live: string | null;
  status: string;
  owner: string | null;
  notes: string | null;
  signedBy: string | null;
  signedAt: string | null;
};

const CATEGORY_LABELS: Record<string, string> = {
  paediatrics: "Paediatrics",
  gp_adults: "GP / adults",
  gynaecology: "Gynaecology",
  medication_sequence: "Medication sequence",
  escalation: "Escalation",
  operational: "Operational",
  recall: "Recall",
  engine: "Engine and gate",
};
const STATUS_LABELS: Record<string, string> = {
  approved: "Signed off",
  blocking: "Blocking",
  awaiting: "Awaiting sign-off",
  confirm_exclusion: "Confirm exclusion",
};

const show = (v: string | null) => (v === null || v === "" ? "—" : v);

export function SettingsBoard({
  items,
  canManage,
  defaultSigner,
}: {
  items: SettingItem[];
  canManage: boolean;
  defaultSigner: string;
}) {
  const [signing, setSigning] = React.useState<SettingItem | null>(null);
  const [history, setHistory] = React.useState<{ key: string; entries: HistoryEntry[] } | null>(
    null,
  );
  const [pending, startTransition] = React.useTransition();

  const groups = Object.keys(CATEGORY_LABELS)
    .map((c) => ({ category: c, rows: items.filter((i) => i.category === c) }))
    .filter((g) => g.rows.length);

  function revoke(item: SettingItem) {
    const extra = isGuardedKey(item.key)
      ? " This stops the behaviour it controls immediately."
      : "";
    if (!confirm(`Revoke the sign-off for "${item.label}"?${extra}`)) return;
    startTransition(async () => {
      const res = await revokeSetting(item.key);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  function openHistory(key: string) {
    startTransition(async () => {
      const res = await loadSettingHistory(key);
      if (res.ok) setHistory({ key, entries: res.entries });
      else toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-8">
      {groups.length === 0 && (
        <p className="text-muted-foreground text-sm">No clinical settings have been created yet.</p>
      )}
      {groups.map((g) => (
        <section key={g.category} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{CATEGORY_LABELS[g.category]}</h3>
          <div className="divide-y rounded-md border">
            {g.rows.map((i) => (
              <div key={i.key} className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{i.label}</span>
                    <Badge
                      variant={
                        i.status === "approved"
                          ? "secondary"
                          : i.status === "blocking"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {STATUS_LABELS[i.status] ?? i.status}
                    </Badge>
                    {isGuardedKey(i.key) && <Badge variant="outline">guarded</Badge>}
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">{i.key}</p>
                  <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-3">
                    <div className="min-w-0">
                      <dt className="text-muted-foreground inline">Proposed: </dt>
                      <dd className="inline break-words">{show(i.proposed)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground inline">Approved: </dt>
                      <dd className="inline font-medium break-words">{show(i.approved)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground inline">In use today: </dt>
                      <dd className="inline break-words">{show(i.live)}</dd>
                    </div>
                  </dl>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {[
                      i.owner && `Owner ${i.owner}`,
                      i.signedBy &&
                        `Signed by ${i.signedBy}${i.signedAt ? ` on ${i.signedAt}` : ""}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {i.notes && <p className="text-muted-foreground mt-1 text-xs">{i.notes}</p>}
                </div>
                <div className="flex flex-wrap items-start gap-2 md:justify-end">
                  {canManage && (
                    <>
                      <Button size="sm" disabled={pending} onClick={() => setSigning(i)}>
                        {i.status === "approved" ? "Change" : "Sign off"}
                      </Button>
                      {i.status === "approved" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => revoke(i)}
                        >
                          Revoke
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => openHistory(i.key)}
                      >
                        History
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {signing && (
        <SignOffDialog
          key={signing.key}
          item={signing}
          defaultSigner={defaultSigner}
          onClose={() => setSigning(null)}
        />
      )}

      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>History</DialogTitle>
            <DialogDescription className="font-mono text-xs">{history?.key}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 divide-y overflow-y-auto text-sm">
            {history?.entries.length === 0 && (
              <li className="text-muted-foreground py-3">No changes recorded.</li>
            )}
            {history?.entries.map((h, n) => (
              <li key={n} className="py-2">
                <span className="text-muted-foreground text-xs">
                  {new Date(h.at).toLocaleString()} {h.by ? "· by a team member" : "· system"}
                </span>
                <div>
                  {show(h.from)} → <span className="font-medium">{show(h.to)}</span>{" "}
                  <span className="text-muted-foreground text-xs">
                    ({STATUS_LABELS[h.status ?? ""] ?? h.status})
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SignOffDialog({
  item,
  defaultSigner,
  onClose,
}: {
  item: SettingItem;
  defaultSigner: string;
  onClose: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const initial = (item.approved ?? item.proposed ?? "").trim();
  const [value, setValue] = React.useState(
    item.valueType === "list" ? listToLines(initial) : initial,
  );
  const [signedBy, setSignedBy] = React.useState(item.signedBy ?? defaultSigner);
  const [signedAt, setSignedAt] = React.useState(new Date().toISOString().slice(0, 10));
  const [confirmText, setConfirmText] = React.useState("");
  const [owner, setOwner] = React.useState(item.owner ?? "");
  const [notes, setNotes] = React.useState(item.notes ?? "");
  const guarded = isGuardedKey(item.key);

  function submit() {
    startTransition(async () => {
      if (owner !== (item.owner ?? "") || notes !== (item.notes ?? "")) {
        const m = await updateSettingMeta({
          key: item.key,
          proposedValue: item.proposed,
          owner: owner || null,
          notes: notes || null,
        });
        if (!m.ok) {
          toast.error(m.error);
          return;
        }
      }
      const res = await signOffSetting({
        key: item.key,
        value,
        signedBy,
        signedAt,
        confirm: confirmText,
      });
      if (res.ok) {
        toast.success(res.message);
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign off: {item.label}</DialogTitle>
          <DialogDescription>
            Signing off records who approved this value and when. Rules start using it immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <Label htmlFor="so-value">Approved value ({item.valueType})</Label>
            {item.valueType === "boolean" ? (
              <select
                id="so-value"
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                <option value="">Choose…</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : item.valueType === "list" || item.valueType === "json" ? (
              <Textarea
                id="so-value"
                rows={6}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={item.valueType === "list" ? "One term per line" : "{}"}
              />
            ) : (
              <Input
                id="so-value"
                inputMode={item.valueType === "number" ? "decimal" : undefined}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="so-by">Signed by</Label>
              <Input id="so-by" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="so-at">Date</Label>
              <Input
                id="so-at"
                type="date"
                value={signedAt}
                onChange={(e) => setSignedAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="so-owner">Owner</Label>
              <Input id="so-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="so-notes">Notes</Label>
            <Textarea
              id="so-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {guarded && (
            <div className="flex flex-col gap-1 rounded-md border border-red-300 p-3">
              <p className="text-xs">
                {item.key === "clinical_messaging_enabled"
                  ? "This lets approved clinical templates reach real patients."
                  : "This lets unsigned proposed values drive rules. Use for internal validation only."}{" "}
                Type <span className="font-mono">{CONFIRM_PHRASE}</span> to switch it on.
              </p>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            Sign off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function listToLines(raw: string): string {
  try {
    const p: unknown = JSON.parse(raw);
    if (Array.isArray(p)) return p.filter((x) => typeof x === "string").join("\n");
  } catch {
    /* fall through */
  }
  return raw;
}
