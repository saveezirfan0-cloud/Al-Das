"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Field } from "@/components/finance/forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/finance/format";

import { prepareOpeningBalances } from "./actions";

type Row = { id: string; code: string; name: string; nature: string };

const cents = (v: string) => {
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

/** One row per ledger: a debit or a credit at the opening date. Must balance before it can be submitted. */
export function OpeningGrid({ accounts, defaultDate }: { accounts: Row[]; defaultDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [filter, setFilter] = useState("");
  const [values, setValues] = useState<Record<string, { debit: string; credit: string }>>({});
  const [pending, start] = useTransition();
  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const v of Object.values(values)) {
      dr += cents(v.debit);
      cr += cents(v.credit);
    }
    return { dr, cr };
  }, [values]);
  const shown = filter
    ? accounts.filter((a) => `${a.code} ${a.name}`.toLowerCase().includes(filter.toLowerCase()))
    : accounts;
  const set = (id: string, side: "debit" | "credit", v: string) =>
    setValues((s) => ({ ...s, [id]: { ...(s[id] ?? { debit: "", credit: "" }), [side]: v } }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Opening date">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
          />
        </Field>
        <Field label="Find an account">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="w-60" />
        </Field>
        <div className="flex items-center gap-2 text-sm">
          Debits {money(totals.dr / 100)} · Credits {money(totals.cr / 100)}
          <Badge variant={totals.dr === totals.cr && totals.dr > 0 ? "success" : "warning"}>
            {totals.dr === totals.cr
              ? "Balanced"
              : `Difference ${money((totals.dr - totals.cr) / 100)}`}
          </Badge>
        </div>
        <Button
          disabled={pending || totals.dr !== totals.cr || totals.dr === 0}
          onClick={() =>
            start(async () => {
              const lines = Object.entries(values)
                .map(([account_id, v]) => ({
                  account_id,
                  debit: cents(v.debit) / 100,
                  credit: cents(v.credit) / 100,
                }))
                .filter((l) => l.debit > 0 || l.credit > 0);
              const res = await prepareOpeningBalances({ date, lines });
              if (res.ok && res.data) {
                toast.success(res.message ?? "Saved");
                router.push(`/accounting/journals/${res.data.id}`);
              } else if (!res.ok) toast.error(res.error);
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />} Submit for posting
        </Button>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="w-40 text-right">Debit</TableHead>
              <TableHead className="w-40 text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <span className="text-muted-foreground mr-2 font-mono text-xs">{a.code}</span>
                  {a.name}
                  <span className="text-muted-foreground ml-2 text-xs">{a.nature}</span>
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    className="text-right"
                    aria-label={`Debit ${a.code}`}
                    value={values[a.id]?.debit ?? ""}
                    onChange={(e) => set(a.id, "debit", e.target.value)}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    className="text-right"
                    aria-label={`Credit ${a.code}`}
                    value={values[a.id]?.credit ?? ""}
                    onChange={(e) => set(a.id, "credit", e.target.value)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
