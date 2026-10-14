"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { searchContactsQuick } from "@/app/(app)/contacts/actions";
import { Input } from "@/components/ui/input";
import { formatPhone } from "@/lib/phone";

export type FoundPatient = { id: string; name: string; phone: string | null };

/** The desk's patient lookup (name or phone). Used on the board, in the Book drawer and on a phone. */
export function PatientSearch({
  searchRef,
  onPick,
  placeholder = "Find a patient: name or phone (press /)",
  label = "Find a patient",
}: {
  searchRef?: React.RefObject<HTMLInputElement | null>;
  onPick: (patient: FoundPatient) => void;
  placeholder?: string;
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<FoundPatient[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      void searchContactsQuick(q.trim()).then((r) => {
        if (!cancelled && r.ok && r.data)
          setRows(
            r.data.rows.map((x) => ({
              id: x.id,
              name: x.full_name || "Unnamed",
              phone: x.phone_e164 ? formatPhone(x.phone_e164) : null,
            })),
          );
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [q]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" aria-hidden />
        <Input
          ref={searchRef}
          className="pl-8"
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={label}
        />
      </div>
      {rows.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                onClick={() => {
                  onPick(r);
                  setQ("");
                }}
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground text-xs">{r.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
