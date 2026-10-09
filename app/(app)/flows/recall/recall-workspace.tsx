"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Search,
  Settings2,
  Send,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { RunSummary } from "@/lib/recall/engine";

import { KeyValueEditor, NumberField, SelectField, TextField } from "../[id]/fields";
import {
  checkProgramme,
  runProgrammeNow,
  saveProgrammeTemplate,
  seedRecallProgrammes,
  setProgrammeStatus,
  updateProgramme,
} from "./actions";
import { SKIP_LABEL, type ProgrammeView, type RecallBootstrap } from "./types";

const KIND: Record<string, string> = {
  chronic: "Chronic care",
  birthday: "Birthday",
  screening: "Screening",
  dormant: "Dormant patients",
  post_visit: "After a visit",
  no_show: "No-show",
  reminder: "Reminder",
};
const STATUS: Record<
  ProgrammeView["status"],
  { label: string; variant: "success" | "warning" | "outline" }
> = {
  active: { label: "On", variant: "success" },
  paused: { label: "Paused", variant: "warning" },
  draft: { label: "Off", variant: "outline" },
};

export function RecallWorkspace({ boot }: { boot: RecallBootstrap }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<ProgrammeView | null>(null);
  const [result, setResult] = React.useState<{
    programme: ProgrammeView;
    summary: RunSummary;
  } | null>(null);
  const [liveConfirm, setLiveConfirm] = React.useState<ProgrammeView | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const mode = (p: ProgrammeView) => p.modeOverride ?? boot.workspaceMode;

  async function act(
    p: ProgrammeView,
    key: string,
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) {
    setBusy(`${p.id}:${key}`);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return void toast.error(r.error ?? "Something went wrong.");
    if (r.message) toast.success(r.message);
    router.refresh();
  }

  async function check(p: ProgrammeView) {
    setBusy(`${p.id}:check`);
    const r = await checkProgramme(p.id);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    setResult({ programme: p, summary: r.data });
    router.refresh();
  }

  async function runNow(p: ProgrammeView, confirmed = false) {
    setBusy(`${p.id}:run`);
    const r = await runProgrammeNow(p.id, confirmed);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    setLiveConfirm(null);
    toast.success(r.message);
    setResult({ programme: p, summary: r.data });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Alert variant={boot.gateOpen ? "default" : "destructive"}>
        <AlertDescription className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Workspace mode:{" "}
            <strong>
              {boot.workspaceMode === "live"
                ? "Live (real patients)"
                : "Test (internal validation patients only)"}
            </strong>
          </span>
          <span>
            Clinical messaging: <strong>{boot.gateOpen ? "signed off" : "not signed off"}</strong>
            {!boot.gateOpen ? " (chronic recall only counts who would be messaged)" : ""}
          </span>
          <span>
            Chronic recall after:{" "}
            <strong>
              {boot.minDays === null
                ? "not signed off (nobody is recalled)"
                : `${boot.minDays} days`}
            </strong>
          </span>
        </AlertDescription>
      </Alert>

      {boot.programmes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6 text-sm">
            <p>
              No programmes yet. Set up the standard ones: chronic recall, birthday, annual check-up
              and screenings, dormant patients, and the appointment-reminder entry. Every one starts
              off, with no template mapped, so nothing is sent until you choose.
            </p>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                setBusy("seed");
                const r = await seedRecallProgrammes();
                setBusy(null);
                if (!r.ok) return void toast.error(r.error);
                toast.success(r.message);
                router.refresh();
              }}
            >
              {busy === "seed" ? <Loader2 className="size-4 animate-spin" /> : null}
              Set up the standard programmes
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {boot.programmes.map((p) => {
          const mapped = p.templates.filter((t) => t.waTemplateId && t.active).length;
          const m = mode(p);
          return (
            <Card key={p.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge variant="outline">{KIND[p.kind] ?? p.kind}</Badge>
                      <Badge variant={STATUS[p.status].variant}>{STATUS[p.status].label}</Badge>
                      {p.eligibility !== "managed" ? (
                        <Badge variant={m === "live" ? "destructive" : "secondary"}>
                          {m === "live" ? "Live" : "Test"}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {p.eligibility !== "managed" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={`Settings for ${p.name}`}
                      onClick={() => setEditing(p)}
                    >
                      <Settings2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {p.eligibility === "managed" ? (
                  <p className="text-muted-foreground">
                    Appointment reminders run on the appointments engine: their schedule (how long
                    before the visit) and templates are set in Settings → Appointments, and they are
                    logged on each appointment.
                  </p>
                ) : (
                  <>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground flex items-center gap-1">
                        <CalendarClock className="size-3.5" /> Schedule
                      </dt>
                      <dd>
                        {p.cron ? <code className="text-xs">{p.cron}</code> : "None"} · up to{" "}
                        {p.maxPerRun} per run{p.repeat === "once" ? " · once per patient" : ""}
                      </dd>
                      <dt className="text-muted-foreground">Templates</dt>
                      <dd className={mapped === 0 ? "text-destructive" : ""}>
                        {mapped} of {p.templates.length || 1} mapped
                        {mapped === 0 ? " · nothing is sent yet" : ""}
                      </dd>
                      <dt className="text-muted-foreground">Last 30 days</dt>
                      <dd className="tabular-nums">
                        {p.funnel.sent} sent · {p.funnel.replied} replied · {p.funnel.booked} booked
                        {p.funnel.failed ? ` · ${p.funnel.failed} failed` : ""}
                      </dd>
                      <dt className="text-muted-foreground">Last run</dt>
                      <dd>
                        {p.lastRun ? (
                          <span>
                            {new Date(p.lastRun.at).toLocaleString()} ·{" "}
                            {p.lastRun.dry
                              ? `would message ${Object.values(p.lastRun.bySegment).reduce((a, b) => a + b, 0)}`
                              : `${p.lastRun.queued} queued`}{" "}
                            of {p.lastRun.scanned} checked
                          </span>
                        ) : (
                          "Never"
                        )}
                      </dd>
                    </dl>
                    <div className="flex flex-wrap gap-1.5">
                      {p.status === "active" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => act(p, "status", () => setProgrammeStatus(p.id, "paused"))}
                        >
                          {busy === `${p.id}:status` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Pause className="size-4" />
                          )}
                          Pause
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => act(p, "status", () => setProgrammeStatus(p.id, "active"))}
                        >
                          {busy === `${p.id}:status` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Play className="size-4" />
                          )}
                          Turn on
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => check(p)}
                      >
                        {busy === `${p.id}:check` ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Search className="size-4" />
                        )}
                        Check eligibility
                      </Button>
                      {p.status === "active" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => (m === "live" ? setLiveConfirm(p) : runNow(p))}
                        >
                          {busy === `${p.id}:run` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Send className="size-4" />
                          )}
                          Run now
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ProgrammeSheet
        programme={editing}
        boot={boot}
        onClose={() => setEditing(null)}
        onSaved={() => router.refresh()}
      />

      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {result?.summary.dryRun ? "Who would be messaged" : "Run finished"}
            </DialogTitle>
            <DialogDescription>
              {result?.programme.name} ·{" "}
              {result?.summary.sendMode === "live"
                ? "live mode"
                : "test mode (internal validation patients only)"}
              . Counts only: no names are shown here.
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div className="space-y-3 text-sm">
              <p>
                Checked <strong>{result.summary.scanned}</strong> patients.{" "}
                {result.summary.dryRun ? (
                  <>
                    Would message{" "}
                    <strong>
                      {Object.values(result.summary.bySegment).reduce((a, b) => a + b, 0)}
                    </strong>
                    .
                  </>
                ) : (
                  <>
                    Queued <strong>{result.summary.queued}</strong>.
                  </>
                )}
              </p>
              {result.summary.note ? (
                <p className="text-muted-foreground">{result.summary.note}</p>
              ) : null}
              {Object.keys(result.summary.bySegment).length ? (
                <div>
                  <h4 className="pb-1 font-medium">By group</h4>
                  <ul className="space-y-0.5">
                    {Object.entries(result.summary.bySegment).map(([k, n]) => (
                      <li key={k} className="flex justify-between">
                        <span>{k === "*" ? "Everyone eligible" : k.replaceAll("_", " ")}</span>
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {Object.keys(result.summary.skipped).length ? (
                <div>
                  <h4 className="pb-1 font-medium">Not messaged</h4>
                  <ul className="space-y-0.5">
                    {Object.entries(result.summary.skipped).map(([k, n]) => (
                      <li key={k} className="flex justify-between">
                        <span>{SKIP_LABEL[k] ?? k.replaceAll("_", " ")}</span>
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!liveConfirm} onOpenChange={(o) => !o && setLiveConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Message real patients now?</DialogTitle>
            <DialogDescription>
              “{liveConfirm?.name}” is in live mode. Running it now queues messages to real
              patients, up to {liveConfirm?.maxPerRun}. Check eligibility first if you are not sure
              who is included.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLiveConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => liveConfirm && runNow(liveConfirm, true)}>
              Run live
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProgrammeSheet({
  programme,
  boot,
  onClose,
  onSaved,
}: {
  programme: ProgrammeView | null;
  boot: RecallBootstrap;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    cron: "",
    max: 100,
    mode: "" as "" | "test" | "live",
    channel: "",
    minDays: "",
    maxDays: "",
    gender: "",
    minAge: "",
    maxAge: "",
    shadow: false,
  });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!programme) return;
    const c = programme.config as Record<string, number | string | null | undefined>;
    setForm({
      cron: programme.cron ?? "",
      max: programme.maxPerRun,
      mode: programme.modeOverride ?? "",
      channel: programme.channelId ?? "",
      minDays: c.min_days?.toString() ?? "",
      maxDays: c.max_days?.toString() ?? "",
      gender: (c.gender as string) ?? "",
      minAge: c.min_age?.toString() ?? "",
      maxAge: c.max_age?.toString() ?? "",
      shadow: (programme.config as { shadow?: boolean }).shadow === true,
    });
  }, [programme]);
  if (!programme) return <Sheet open={false} onOpenChange={() => onClose()} />;

  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  async function save() {
    if (!programme) return;
    setBusy(true);
    const r = await updateProgramme(programme.id, {
      cron_expression: form.cron.trim() || null,
      max_per_run: form.max,
      send_mode_override: form.mode || null,
      channel_id: form.channel || null,
      config: {
        shadow: form.shadow,
        ...(programme.eligibility === "visit_gap"
          ? {
              min_days: num(form.minDays),
              max_days: num(form.maxDays),
              gender: (form.gender || null) as "male" | "female" | null,
              min_age: num(form.minAge),
              max_age: num(form.maxAge),
            }
          : {}),
      },
    });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.message ?? "Saved.");
    onSaved();
  }

  const bands =
    (programme.config.bands as
      Array<{ key: string; gender: string; min_age?: number; max_age?: number }> | undefined) ?? [];
  const segmentLabel = (k: string) => (k === "*" ? "Everyone eligible" : k.replaceAll("_", " "));
  const segments =
    programme.eligibility === "visit_gap" ? ["*"] : programme.templates.map((t) => t.segment);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{programme.name}</SheetTitle>
          <SheetDescription>
            Who is recalled is decided by the programme’s rule; this page sets when it runs and what
            is sent.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Schedule</h3>
            <TextField
              label="Runs when (cron, workspace time zone)"
              value={form.cron}
              mono
              onChange={(v) => setForm({ ...form, cron: v })}
              placeholder="0 9 * * *"
              help="Minute, hour, day of month, month, weekday."
            />
            <NumberField
              label="At most this many messages per run"
              value={form.max}
              min={1}
              max={2000}
              onChange={(v) => setForm({ ...form, max: v ?? 100 })}
            />
            <SelectField
              label="Send from"
              value={form.channel || undefined}
              allowNone
              noneLabel="The template’s own number"
              onChange={(v) => setForm({ ...form, channel: v ?? "" })}
              options={boot.channels.map((c) => ({ value: c.id, label: c.name }))}
            />
            <SelectField
              label="Mode"
              value={form.mode || undefined}
              allowNone
              noneLabel={`Follow the workspace (${boot.workspaceMode})`}
              onChange={(v) => setForm({ ...form, mode: (v as "test" | "live") ?? "" })}
              options={[
                { value: "test", label: "Always test" },
                ...(boot.canForceLive || programme.modeOverride === "live"
                  ? [{ value: "live", label: "Always live" }]
                  : []),
              ]}
              help="Test sends only to internal validation patients. Going live is a clinical sign-off decision."
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.shadow}
                onChange={(e) => setForm({ ...form, shadow: e.target.checked })}
              />
              <span>
                Record who this would message (parallel run with Make)
                <span className="text-muted-foreground block text-xs">
                  Each scheduled run also stores the Unite PINs it would have messaged, nothing
                  else, so the Parallel run page can compare them with what Make did. It never
                  sends.
                </span>
              </span>
            </label>
          </section>

          {programme.eligibility === "chronic" ? (
            <p className="text-muted-foreground text-sm">
              Chronic recall uses the signed-off minimum days since the last visit (
              {boot.minDays ?? "not signed off"}), the patient’s primary messageable condition and
              clinical-messaging consent. It needs the clinical gate open.
            </p>
          ) : null}

          {programme.eligibility === "birthday" ? (
            <section className="space-y-1">
              <h3 className="text-sm font-semibold">Age bands</h3>
              <ul className="text-sm">
                {bands.map((b) => (
                  <li key={b.key} className="flex justify-between">
                    <span className="capitalize">{b.key.replaceAll("_", " ")}</span>
                    <span className="text-muted-foreground">
                      {b.gender}, {b.min_age ?? 0}–{b.max_age ?? "∞"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-xs">
                Patients outside every band get nothing. They are counted in each run so the gap is
                visible.
              </p>
            </section>
          ) : null}

          {programme.eligibility === "visit_gap" ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Who is eligible</h3>
              <p className="text-muted-foreground text-xs">
                Patients whose last visit was at least this many days ago. Leave “at least” empty
                and nobody is recalled.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Days since last visit: at least"
                  value={form.minDays}
                  onChange={(v) => setForm({ ...form, minDays: v.replace(/\D/g, "") })}
                />
                <TextField
                  label="…at most (optional)"
                  value={form.maxDays}
                  onChange={(v) => setForm({ ...form, maxDays: v.replace(/\D/g, "") })}
                />
                <TextField
                  label="Age: at least"
                  value={form.minAge}
                  onChange={(v) => setForm({ ...form, minAge: v.replace(/\D/g, "") })}
                />
                <TextField
                  label="Age: at most"
                  value={form.maxAge}
                  onChange={(v) => setForm({ ...form, maxAge: v.replace(/\D/g, "") })}
                />
              </div>
              <SelectField
                label="Gender"
                value={form.gender || undefined}
                allowNone
                noneLabel="Any"
                onChange={(v) => setForm({ ...form, gender: v ?? "" })}
                options={[
                  { value: "female", label: "Female" },
                  { value: "male", label: "Male" },
                ]}
              />
            </section>
          ) : null}

          <div className="flex justify-end">
            <Button onClick={save} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save settings
            </Button>
          </div>

          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-semibold">Templates</h3>
            <p className="text-muted-foreground text-xs">
              One template per group. A group with no template is skipped and counted; nothing is
              sent by default. Chronic recall also needs the template marked clinically approved.
            </p>
            {segments.map((seg) => {
              const row = programme.templates.find((t) => t.segment === seg);
              return (
                <TemplateRow
                  key={seg}
                  programme={programme}
                  segment={seg}
                  label={segmentLabel(seg)}
                  row={row}
                  boot={boot}
                  onSaved={onSaved}
                />
              );
            })}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TemplateRow({
  programme,
  segment,
  label,
  row,
  boot,
  onSaved,
}: {
  programme: ProgrammeView;
  segment: string;
  label: string;
  row?: ProgrammeView["templates"][number];
  boot: RecallBootstrap;
  onSaved: () => void;
}) {
  const [tpl, setTpl] = React.useState(row?.waTemplateId ?? "");
  const [vars, setVars] = React.useState<Record<string, string>>(row?.variables ?? {});
  const [active, setActive] = React.useState(row?.active ?? true);
  const [busy, setBusy] = React.useState(false);
  const picked = boot.waTemplates.find((t) => t.id === tpl);
  const clinical = programme.kind === "chronic";

  async function save() {
    setBusy(true);
    const r = await saveProgrammeTemplate(programme.id, segment, {
      wa_template_id: tpl || null,
      variables_map: vars,
      active,
    });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Saved.");
    onSaved();
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium capitalize">{label}</span>
        {row?.legacyId ? (
          <span className="text-muted-foreground text-xs">Make template {row.legacyId}</span>
        ) : null}
      </div>
      <SelectField
        label="Template"
        value={tpl || undefined}
        allowNone
        noneLabel="None (skip this group)"
        onChange={(v) => setTpl(v ?? "")}
        options={boot.waTemplates.map((t) => ({
          value: t.id,
          label: `${t.name} (${t.language})${t.status === "APPROVED" ? "" : ` · ${t.status.toLowerCase()}`}`,
        }))}
      />
      {picked && picked.status !== "APPROVED" ? (
        <p className="flex items-center gap-1 text-xs text-amber-600">
          <AlertTriangle className="size-3.5" /> Not approved by Meta yet: it will be skipped.
        </p>
      ) : null}
      {picked && clinical ? (
        <p
          className={`flex items-center gap-1 text-xs ${picked.clinical_approval === "approved" ? "text-emerald-600" : "text-amber-600"}`}
        >
          {picked.clinical_approval === "approved" ? (
            <CheckCircle2 className="size-3.5" />
          ) : (
            <AlertTriangle className="size-3.5" />
          )}
          {picked.clinical_approval === "approved"
            ? "Clinically approved."
            : "Not clinically approved: chronic recall will not send it."}
        </p>
      ) : null}
      <KeyValueEditor
        label="Variable values"
        keyLabel="Variable"
        keyOptions={["body.1", "body.2", "body.3", "header.1"]}
        value={vars}
        onChange={setVars}
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Use this mapping
        </label>
        <Button size="sm" variant="outline" onClick={save} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Save template
        </Button>
      </div>
    </div>
  );
}
