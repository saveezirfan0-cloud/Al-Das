"use client";

import * as React from "react";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPhone } from "@/lib/phone";

import { searchContactsForEnquiry, type ContactOption } from "./actions";

/** Pick (or unlink) the contact an enquiry belongs to. */
export function ContactPicker({
  value,
  onChange,
  disabled,
  id,
  search = searchContactsForEnquiry,
}: {
  value: ContactOption | null;
  onChange: (c: ContactOption | null) => void;
  disabled?: boolean;
  id?: string;
  /** Permission-checked search action; defaults to the enquiries one. */
  search?: (
    q: string,
  ) => Promise<{ ok: true; data: { rows: ContactOption[] } } | { ok: false; error: string }>;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<ContactOption[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      const res = await search(q);
      if (cancelled) return;
      setLoading(false);
      setResults(res.ok ? res.data.rows : []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  if (value) {
    return (
      <div className="bg-muted/40 flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
        <span className="truncate font-medium">{value.full_name || "Unnamed contact"}</span>
        <span className="text-muted-foreground truncate tabular-nums">
          {formatPhone(value.phone_e164)}
        </span>
        {!disabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-6"
            aria-label="Unlink contact"
            onClick={() => onChange(null)}
          >
            <X />
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="relative">
      <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
      <Input
        id={id}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={disabled}
        placeholder="Search name or phone"
        className="pl-8"
        autoComplete="off"
      />
      {loading && (
        <Loader2 className="text-muted-foreground absolute top-1/2 right-2 size-4 -translate-y-1/2 animate-spin" />
      )}
      {results.length > 0 && (
        <ul className="bg-popover absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border p-1 shadow-md">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm"
                onClick={() => {
                  onChange(c);
                  setQ("");
                  setResults([]);
                }}
              >
                <span className="truncate">{c.full_name || "Unnamed contact"}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatPhone(c.phone_e164)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
