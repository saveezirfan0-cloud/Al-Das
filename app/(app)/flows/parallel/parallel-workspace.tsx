"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  computeComparison,
  recordMakeOff,
  saveDayNote,
  seedParallelScenarios,
  signOffScenario,
  updateScenario,
  uploadMakeKeys,
} from "./actions";

export type ScenarioView = {
  id: string;
  key: string;
  label: string;
  makeIds: string | null;
  nativeSummary: string | null;
  compareKind: "ids" | "health" | "none";
  nativeReady: boolean;
  startedOn: string | null;
  makeOffOn: string | null;
  signedOffBy: string | null;
  signedOffOn: string | null;
  notes: string | null;
  health: { total: number; ok: number } | null;
  blockers: string[];
  days: Array<{
    date: string;
    make: number;
    native: number;
    onlyInMake: string[];
    onlyInNative: string[];
    note: string;
  }>;
};

export function ParallelWorkspace({
  scenarios,
  today,
}: {
  scenarios: ScenarioView[];
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function run(
    key: string,
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return void toast.error(r.error ?? "Something went wrong.");
    if (r.message) toast.success(r.message);
    router.refresh();
  }

  if (scenarios.length === 0)
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-6 text-sm">
          <p>
            Create the checklist for the six scenarios Make runs today. Each one starts as “not
            signed off”.
          </p>
          <Button disabled={busy !== null} onClick={() => run("seed", seedParallelScenarios)}>
            {busy === "seed" ? <Loader2 className="size-4 animate-spin" /> : null}
            Create the checklist
          </Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => run("compare", () => computeComparison(7))}
        >
          {busy === "compare" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Compare the last 7 days
        </Button>
        <span className="text-muted-foreground text-xs">
          Only identifiers (appointment ids and Unite PINs) are compared; no names or phone numbers
          are stored here.
        </span>
      </div>
      {scenarios.map((s) => (
        <ScenarioCard key={s.id} s={s} today={today} busy={busy} run={run} />
      ))}
    </div>
  );
}

function ScenarioCard({
  s,
  today,
  busy,
  run,
}: {
  s: ScenarioView;
  today: string;
  busy: string | null;
  run: (
    k: string,
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) => Promise<void>;
}) {
  const [started, setStarted] = React.useState(s.startedOn ?? "");
  const [signer, setSigner] = React.useState("");
  const [paste, setPaste] = React.useState("");
  const [pasteDate, setPasteDate] = React.useState(today);
  const [offDate, setOffDate] = React.useState(today);
  const ready = s.blockers.length === 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{s.label}</CardTitle>
            <p className="text-muted-foreground text-xs">Make scenario {s.makeIds ?? "—"}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {s.makeOffOn ? (
              <Badge variant="success">Make off since {s.makeOffOn}</Badge>
            ) : s.signedOffOn ? (
              <Badge variant="success">Signed off {s.signedOffOn}</Badge>
            ) : ready ? (
              <Badge variant="secondary">Ready to sign off</Badge>
            ) : (
              <Badge variant="outline">Not signed off</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {s.nativeSummary ? <p className="text-muted-foreground">{s.nativeSummary}</p> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.nativeReady}
              disabled={s.compareKind === "none" || busy !== null}
              onChange={(e) =>
                run(`${s.id}:ready`, () => updateScenario(s.id, { native_ready: e.target.checked }))
              }
            />
            The native version is built and running in Test mode
          </label>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor={`start-${s.id}`}>Parallel run started on</Label>
              <Input
                id={`start-${s.id}`}
                type="date"
                value={started}
                onChange={(e) => setStarted(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || started === (s.startedOn ?? "")}
              onClick={() =>
                run(`${s.id}:start`, () =>
                  updateScenario(s.id, { parallel_started_on: started || null }),
                )
              }
            >
              Save
            </Button>
          </div>
        </div>

        {s.compareKind === "health" && s.health ? (
          <p>
            Unite calls in the last 7 days: <strong>{s.health.total}</strong>, successful{" "}
            <strong>
              {s.health.total ? ((s.health.ok / s.health.total) * 100).toFixed(1) : "0"}%
            </strong>
            .
          </p>
        ) : null}

        {s.compareKind === "ids" ? (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2">Day</th>
                    <th className="p-2">Make</th>
                    <th className="p-2">Native</th>
                    <th className="p-2">Only in Make</th>
                    <th className="p-2">Only native</th>
                    <th className="p-2">Why (if different)</th>
                  </tr>
                </thead>
                <tbody>
                  {s.days.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted-foreground p-3 text-center">
                        Nothing compared yet. Load what Make did, then compare.
                      </td>
                    </tr>
                  ) : (
                    s.days.map((d) => <DayRow key={d.date} scenario={s.key} d={d} />)
                  )}
                </tbody>
              </table>
            </div>
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer font-medium">
                <Upload className="mr-1 inline size-3.5" />
                Load what Make did
              </summary>
              <div className="mt-3 space-y-2">
                <p className="text-muted-foreground text-xs">
                  Paste the identifiers from Make’s log table (one per line, or “id,date”).{" "}
                  {s.key === "birthday" || s.key.startsWith("chronic")
                    ? "Use the Unite PIN."
                    : "Use the Unite appointment id."}{" "}
                  Only the first two columns are read; anything else is discarded.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor={`pd-${s.id}`}>Day (when a line has none)</Label>
                    <Input
                      id={`pd-${s.id}`}
                      type="date"
                      value={pasteDate}
                      onChange={(e) => setPasteDate(e.target.value)}
                    />
                  </div>
                </div>
                <Textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  rows={5}
                  className="font-mono text-xs"
                  aria-label={`Identifiers Make handled for ${s.label}`}
                />
                <Button
                  size="sm"
                  disabled={busy !== null || !paste.trim()}
                  onClick={() =>
                    run(`${s.id}:upload`, async () => {
                      const r = await uploadMakeKeys({
                        scenario: s.key,
                        date: pasteDate || null,
                        text: paste,
                      });
                      if (r.ok) setPaste("");
                      return r;
                    })
                  }
                >
                  {busy === `${s.id}:upload` ? <Loader2 className="size-4 animate-spin" /> : null}
                  Store identifiers
                </Button>
              </div>
            </details>
          </>
        ) : null}

        {s.blockers.length > 0 ? (
          <Alert>
            <AlertDescription>
              <p className="flex items-center gap-1 font-medium">
                <AlertTriangle className="size-4" /> Before sign-off
              </p>
              <ul className="list-disc pl-5">
                {s.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {s.signedOffOn ? (
          <div className="flex flex-wrap items-end gap-2">
            <p className="flex items-center gap-1">
              <CheckCircle2 className="size-4 text-emerald-600" /> Signed off by {s.signedOffBy} on{" "}
              {s.signedOffOn}.
            </p>
            {!s.makeOffOn ? (
              <>
                <Input
                  type="date"
                  value={offDate}
                  onChange={(e) => setOffDate(e.target.value)}
                  className="w-40"
                  aria-label="Date Make was turned off"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => run(`${s.id}:off`, () => recordMakeOff(s.id, offDate))}
                >
                  I turned the Make scenario off
                </Button>
              </>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor={`signer-${s.id}`}>Signed off by</Label>
              <Input
                id={`signer-${s.id}`}
                value={signer}
                onChange={(e) => setSigner(e.target.value)}
                placeholder="Name"
                className="w-48"
              />
            </div>
            <Button
              size="sm"
              disabled={busy !== null || !ready || signer.trim().length < 2}
              onClick={() => run(`${s.id}:sign`, () => signOffScenario(s.id, signer))}
            >
              Sign off
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DayRow({ scenario, d }: { scenario: string; d: ScenarioView["days"][number] }) {
  const router = useRouter();
  const differs = d.onlyInMake.length > 0 || d.onlyInNative.length > 0;
  const [note, setNote] = React.useState(d.note);
  return (
    <tr className="border-t align-top">
      <td className="p-2 whitespace-nowrap">{d.date}</td>
      <td className="p-2 tabular-nums">{d.make}</td>
      <td className="p-2 tabular-nums">{d.native}</td>
      <td className="p-2">
        <IdList ids={d.onlyInMake} />
      </td>
      <td className="p-2">
        <IdList ids={d.onlyInNative} />
      </td>
      <td className="p-2">
        {differs ? (
          <Input
            aria-label={`Why ${scenario} differs on ${d.date}`}
            value={note}
            maxLength={500}
            className="h-7 min-w-48 text-xs"
            placeholder="e.g. already messaged once; band not covered"
            onChange={(e) => setNote(e.target.value)}
            onBlur={async () => {
              if (note === d.note) return;
              const r = await saveDayNote(scenario, d.date, note);
              if (!r.ok) return void toast.error(r.error);
              router.refresh();
            }}
          />
        ) : (
          <span className="text-muted-foreground">Same</span>
        )}
      </td>
    </tr>
  );
}

function IdList({ ids }: { ids: string[] }) {
  if (ids.length === 0) return <span className="text-muted-foreground">0</span>;
  return (
    <details>
      <summary className="cursor-pointer tabular-nums">{ids.length}</summary>
      <ul className="max-h-32 overflow-y-auto font-mono">
        {ids.slice(0, 200).map((i) => (
          <li key={i}>{i}</li>
        ))}
        {ids.length > 200 ? <li>…and {ids.length - 200} more</li> : null}
      </ul>
    </details>
  );
}
