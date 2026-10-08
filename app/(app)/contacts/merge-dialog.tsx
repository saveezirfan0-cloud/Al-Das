"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { displayName, formatDate } from "@/lib/contacts/format";
import { diffForMerge, MERGE_FIELDS, type MergeField, type MergeSide } from "@/lib/contacts/merge";
import type { ContactListRow } from "@/lib/contacts/query";
import { formatPhone } from "@/lib/phone";

import { mergeContacts, searchContactsQuick } from "./actions";

function side(c: ContactListRow): MergeSide {
  return Object.fromEntries(MERGE_FIELDS.map((f) => [f, (c as unknown as Record<string, string | null>)[f] ?? null]));
}

export function MergeDialog({
  open,
  onOpenChange,
  primary,
  secondary: presetSecondary,
  onMerged,
  onOpenContact,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  primary: ContactListRow;
  secondary?: ContactListRow;
  onMerged: () => void;
  onOpenContact?: (id: string) => void;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<ContactListRow[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [secondary, setSecondary] = React.useState<ContactListRow | null>(presetSecondary ?? null);
  const [swap, setSwap] = React.useState(false);
  const [picks, setPicks] = React.useState<Partial<Record<MergeField, "primary" | "secondary">>>({});
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setSecondary(presetSecondary ?? null);
      setPicks({});
      setSwap(false);
      setQ("");
      setResults([]);
    }
  }, [open, presetSecondary]);

  React.useEffect(() => {
    if (!open || secondary || q.trim().length < 2) return;
    const handle = setTimeout(async () => {
      setSearching(true);
      const res = await searchContactsQuick(q, primary.id);
      setSearching(false);
      if (res.ok) setResults(res.data.rows);
    }, 300);
    return () => clearTimeout(handle);
  }, [q, open, secondary, primary.id]);

  const keep = swap && secondary ? secondary : primary;
  const lose = swap ? primary : secondary;
  const diffs = lose ? diffForMerge(side(keep), side(lose)) : [];

  function submit() {
    if (!lose) return;
    startTransition(async () => {
      const res = await mergeContacts(keep.id, lose.id, picks);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      onMerged();
      if (swap && onOpenContact) onOpenContact(keep.id);
    });
  }

  const row = (c: ContactListRow) => (
    <button type="button" onClick={() => setSecondary(c)} className="hover:bg-accent flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm">
      <span className="font-medium">{displayName(c)}</span>
      <span className="text-muted-foreground text-xs">
        {formatPhone(c.phone_e164)} {c.email && `· ${c.email}`} {c.dob && `· ${formatDate(c.dob)}`}
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge duplicates</DialogTitle>
          <DialogDescription>
            The merged contact keeps the chosen values; blanks are filled from the other record. Tags, phones, segments and history are combined. Opt-outs always win.
          </DialogDescription>
        </DialogHeader>

        {!secondary ? (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the duplicate by name, phone or email" className="pl-8" aria-label="Search duplicate" />
            </div>
            {searching && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
            <div className="flex max-h-64 flex-col overflow-y-auto">{results.map((c) => <React.Fragment key={c.id}>{row(c)}</React.Fragment>)}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-sm">
              <span>
                Keep <strong>{displayName(keep)}</strong>, merge in <strong>{displayName(lose!)}</strong>
              </span>
              <Button variant="ghost" size="sm" onClick={() => setSwap((s) => !s)}>
                Swap
              </Button>
            </div>
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="py-1 text-left font-medium">Field</th>
                  <th className="py-1 text-left font-medium">Keep (primary)</th>
                  <th className="py-1 text-left font-medium">Merge in</th>
                </tr>
              </thead>
              <tbody>
                {diffs
                  .filter((d) => d.primary !== null || d.secondary !== null)
                  .map((d) => {
                    const pick = picks[d.field] ?? "primary";
                    const cell = (val: string | null, which: "primary" | "secondary") => (
                      <td className="py-1 pr-2">
                        {d.conflict ? (
                          <label className="flex cursor-pointer items-center gap-2">
                            <input type="radio" name={`pick-${d.field}`} checked={pick === which} onChange={() => setPicks({ ...picks, [d.field]: which })} />
                            <span className={pick === which ? "font-medium" : "text-muted-foreground"}>{val ?? "—"}</span>
                          </label>
                        ) : (
                          <span className={val === null ? "text-muted-foreground" : ""}>{val ?? "—"}</span>
                        )}
                      </td>
                    );
                    return (
                      <tr key={d.field} className="border-t">
                        <td className="text-muted-foreground py-1 pr-2 text-xs">{d.label}</td>
                        {cell(d.primary, "primary")}
                        {cell(d.secondary, "secondary")}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {diffs.some((d) => d.conflict) && <p className="text-muted-foreground text-xs">Pick a value where both records differ. The losing phone becomes an alternate phone.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => (secondary && !presetSecondary ? setSecondary(null) : onOpenChange(false))}>
            {secondary && !presetSecondary ? "Back" : "Cancel"}
          </Button>
          <Button disabled={!secondary || pending} onClick={submit}>
            {pending && <Loader2 className="animate-spin" />} Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
