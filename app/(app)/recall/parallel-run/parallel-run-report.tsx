"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { explainDiff, updateChecklist } from "../actions";

type Day = { run_date: string; make_count: number; native_count: number; only_in_make: string[]; only_in_native: string[]; explained: boolean; reason: string };
export type ScenarioVM = {
  key: string;
  name: string;
  makeId: string | null;
  nativeBuilt: boolean;
  diffsExplained: boolean;
  makeOff: boolean;
  blockedReason: string | null;
  comparable: boolean;
  days: Day[];
  readiness: { ready: boolean; reasons: string[] };
};

export function ParallelRunReport({ scenarios, canEdit }: { scenarios: ScenarioVM[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const toggle = (scenario_key: string, field: "native_built" | "diffs_explained" | "make_off", value: boolean) =>
    startTransition(async () => {
      const r = await updateChecklist({ scenario_key: scenario_key as never, field, value });
      if (r.ok) router.refresh();
      else toast.error(r.error);
    });

  return (
    <div className="flex flex-col gap-8">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Make scenario</TableHead>
              <TableHead>Native built</TableHead>
              <TableHead>7-day parallel</TableHead>
              <TableHead>Differences explained</TableHead>
              <TableHead>Make off</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scenarios.map((s) => (
              <TableRow key={s.key}>
                <TableCell>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-muted-foreground text-xs">
                    {s.makeId ? `Make #${s.makeId}` : "Airtable"}
                    {s.blockedReason ? ` · ${s.blockedReason}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <Checkbox checked={s.nativeBuilt} disabled={!canEdit || pending} aria-label={`${s.name}: native built`} onCheckedChange={(v) => toggle(s.key, "native_built", v === true)} />
                </TableCell>
                <TableCell className="text-sm">
                  {s.comparable ? (
                    <span className="inline-flex items-center gap-1">
                      {s.days.length >= 7 ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Circle className="text-muted-foreground size-4" />} {Math.min(s.days.length, 7)} / 7 days
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not comparable yet</span>
                  )}
                </TableCell>
                <TableCell>
                  <Checkbox checked={s.diffsExplained} disabled={!canEdit || pending} aria-label={`${s.name}: differences explained`} onCheckedChange={(v) => toggle(s.key, "diffs_explained", v === true)} />
                </TableCell>
                <TableCell>
                  <Checkbox checked={s.makeOff} disabled={!canEdit || pending || !s.readiness.ready} aria-label={`${s.name}: Make switched off`} onCheckedChange={(v) => toggle(s.key, "make_off", v === true)} />
                  {!s.readiness.ready && s.readiness.reasons[0] && <div className="text-muted-foreground mt-1 max-w-48 text-xs">{s.readiness.reasons[0]}</div>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {scenarios
        .filter((s) => s.days.length > 0)
        .map((s) => (
          <section key={s.key} className="flex flex-col gap-2">
            <h3 className="font-semibold">{s.name}: day by day</h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead>Make</TableHead>
                    <TableHead>Native</TableHead>
                    <TableHead>Only in Make</TableHead>
                    <TableHead>Only in native</TableHead>
                    <TableHead>Why they differ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.days.map((d) => {
                    const differs = d.only_in_make.length + d.only_in_native.length > 0;
                    const k = `${s.key}:${d.run_date}`;
                    return (
                      <TableRow key={k}>
                        <TableCell>{d.run_date}</TableCell>
                        <TableCell className="tabular-nums">{d.make_count}</TableCell>
                        <TableCell className="tabular-nums">{d.native_count}</TableCell>
                        <TableCell className="tabular-nums">{d.only_in_make.length}</TableCell>
                        <TableCell className="tabular-nums">{d.only_in_native.length}</TableCell>
                        <TableCell>
                          {!differs ? (
                            <span className="text-emerald-700 text-sm">Identical</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <Input aria-label={`Reason for ${s.name} on ${d.run_date}`} className="min-w-56" value={reasons[k] ?? d.reason} disabled={!canEdit} placeholder="e.g. already messaged by Make before cut-over" onChange={(e) => setReasons((r) => ({ ...r, [k]: e.target.value }))} />
                              <Button
                                size="sm"
                                variant={d.explained ? "secondary" : "default"}
                                disabled={!canEdit || pending}
                                onClick={() =>
                                  startTransition(async () => {
                                    const r = await explainDiff({ scenario_key: s.key as never, run_date: d.run_date, reason: reasons[k] ?? d.reason, explained: true });
                                    if (r.ok) router.refresh();
                                    else toast.error(r.error);
                                  })
                                }
                              >
                                {d.explained ? "Explained" : "Mark explained"}
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        ))}

      <p className="text-muted-foreground text-xs">
        Only salted hashes of Unite PINs and appointment ids are stored for the comparison: no names, phone numbers or messages. Import a day of Make output with{" "}
        <code className="bg-muted rounded px-1">pnpm parallel:ingest --org &lt;slug&gt; --scenario birthday --date YYYY-MM-DD --file ids.txt</code>. The nightly job compares yesterday at 00:30 Dubai time.
      </p>
    </div>
  );
}
