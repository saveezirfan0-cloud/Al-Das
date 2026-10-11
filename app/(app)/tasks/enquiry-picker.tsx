"use client";

import * as React from "react";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { searchEnquiriesForTask, type EnquiryOption } from "./actions";

/** Link a task to an enquiry by number or title. */
export function EnquiryPicker({
  value,
  onChange,
  disabled,
  id,
}: {
  value: EnquiryOption | null;
  onChange: (e: EnquiryOption | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<EnquiryOption[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      const res = await searchEnquiriesForTask(q);
      if (cancelled) return;
      setLoading(false);
      setResults(res.ok ? res.data.rows : []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q]);

  if (value) {
    return (
      <div className="bg-muted/40 flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
        <span className="text-muted-foreground tabular-nums">#{value.number}</span>
        <span className="truncate font-medium">{value.title}</span>
        {!disabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-6"
            aria-label="Unlink enquiry"
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
        placeholder="Enquiry number or title"
        className="pl-8"
        autoComplete="off"
      />
      {loading && (
        <Loader2 className="text-muted-foreground absolute top-1/2 right-2 size-4 -translate-y-1/2 animate-spin" />
      )}
      {results.length > 0 && (
        <ul className="bg-popover absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border p-1 shadow-md">
          {results.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                onClick={() => {
                  onChange(e);
                  setQ("");
                  setResults([]);
                }}
              >
                <span className="text-muted-foreground tabular-nums">#{e.number}</span>
                <span className="truncate">{e.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
