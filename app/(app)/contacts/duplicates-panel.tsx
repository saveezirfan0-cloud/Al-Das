"use client";

import * as React from "react";
import { GitMerge, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { displayName, formatDate } from "@/lib/contacts/format";
import { formatPhone } from "@/lib/phone";

import { listDuplicates, type DuplicatePair } from "./actions";
import { MergeDialog } from "./merge-dialog";

const REASONS: Record<string, string> = {
  email: "Same email",
  name_dob: "Same name and date of birth",
  phone: "Shared phone number",
};

export function DuplicatesPanel({
  timezone,
  canManage,
  onOpenContact,
  onMerged,
}: {
  timezone: string;
  canManage: boolean;
  onOpenContact: (id: string) => void;
  onMerged: () => void;
}) {
  const [pairs, setPairs] = React.useState<DuplicatePair[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [merging, setMerging] = React.useState<DuplicatePair | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    const res = await listDuplicates();
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setPairs(res.data.pairs);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const card = (c: DuplicatePair["a"]) => (
    <button
      type="button"
      onClick={() => onOpenContact(c.id)}
      className="hover:bg-accent flex min-w-0 flex-1 flex-col rounded-md border p-2 text-left text-sm"
    >
      <span className="truncate font-medium">{displayName(c)}</span>
      <span className="text-muted-foreground truncate text-xs">
        {formatPhone(c.phone_e164) || "no phone"} {c.email && `· ${c.email}`}{" "}
        {c.dob && `· ${formatDate(c.dob)}`}
      </span>
      <span className="text-muted-foreground text-xs">
        Created {formatDate(c.created_at, timezone)}
      </span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">Possible duplicates</h3>
          <p className="text-muted-foreground text-sm">
            Pairs that share an email, a name and date of birth, or a phone number.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>
      {pairs === null ? (
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      ) : pairs.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No duplicates found.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pairs.map((p) => (
            <li
              key={`${p.a.id}-${p.b.id}`}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
            >
              <Badge variant="secondary" className="w-44 justify-center">
                {REASONS[p.reason] ?? p.reason}
              </Badge>
              {card(p.a)}
              {card(p.b)}
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => setMerging(p)}>
                  <GitMerge /> Merge
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {merging && (
        <MergeDialog
          open
          onOpenChange={(o) => !o && setMerging(null)}
          primary={merging.a}
          secondary={merging.b}
          onMerged={() => {
            setMerging(null);
            void load();
            onMerged();
          }}
        />
      )}
    </div>
  );
}
