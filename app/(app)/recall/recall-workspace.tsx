"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Eye, FlaskConical, Loader2, Radio, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { describeSchedule, formFromCron } from "@/lib/flow-engine/schedule";

import {
  previewProgramme,
  saveProgramme,
  saveSendingSettings,
  saveTemplateMap,
  type Preview,
} from "./actions";

export type ProgrammeVM = {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: "draft" | "active" | "paused";
  eligibility_view: string | null;
  cron_expression: string | null;
  max_per_run: number;
  send_mode_override: "test" | "live" | null;
  config: Record<string, unknown>;
  last_run_at: string | null;
  templates: Array<{
    id: string;
    segment_key: string;
    wa_template_id: string | null;
    legacy: string | null;
    active: boolean;
  }>;
  last7: Record<string, number>;
  weekly: Array<{
    week_start: string;
    send_mode: string;
    sent: number;
    failed: number;
    replied: number;
    booked: number;
  }>;
};
type TemplateOption = { id: string; name: string; status: string; category: string };
type Workspace = { mode: "test" | "live"; testNumbers: string; clinicalMessagingEnabled: boolean };
type Perms = { manage: boolean; mapTemplates: boolean; signOff: boolean };

const KIND_LABELS: Record<string, string> = {
  chronic: "Chronic condition",
  birthday: "Birthday",
  screening: "Screening",
  dormant: "Dormant patients",
  post_visit: "After a visit",
  no_show: "No-show",
  appointment_reminder: "Appointment reminder",
};
const STATUS_STYLE = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
} as const;

export function RecallWorkspace({
  programmes,
  templates,
  workspace,
  perms,
}: {
  programmes: ProgrammeVM[];
  templates: TemplateOption[];
  workspace: Workspace;
  perms: Perms;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = programmes.find((p) => p.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <SendingPanel workspace={workspace} perms={perms} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Programme</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sending</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Last 7 days</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {programmes.map((p) => {
            const mode = p.send_mode_override ?? workspace.mode;
            const sent =
              (p.last7.queued ?? 0) +
              (p.last7.sent ?? 0) +
              (p.last7.delivered ?? 0) +
              (p.last7.read ?? 0);
            return (
              <TableRow key={p.id} className="cursor-pointer" onClick={() => setOpenId(p.id)}>
                <TableCell>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-muted-foreground text-xs">
                    {KIND_LABELS[p.kind] ?? p.kind}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={STATUS_STYLE[p.status]}>
                    {p.status === "draft" ? "Draft" : p.status === "active" ? "Active" : "Paused"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <ModeBadge mode={mode} inherited={p.send_mode_override === null} />
                </TableCell>
                <TableCell className="text-sm">
                  {p.cron_expression ? describeSchedule(formFromCron(p.cron_expression)) : "—"}
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {sent} sent{p.last7.eligible ? ` · ${p.last7.eligible} counted (test)` : ""}
                  {p.last7.skipped_no_template
                    ? ` · ${p.last7.skipped_no_template} no template`
                    : ""}
                  {p.last7.failed ? ` · ${p.last7.failed} failed` : ""}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" aria-label={`Open ${p.name}`}>
                    <Eye />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {open && (
            <ProgrammeDrawer
              key={open.id}
              p={open}
              templates={templates}
              workspace={workspace}
              perms={perms}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ModeBadge({ mode, inherited }: { mode: "test" | "live"; inherited: boolean }) {
  return mode === "live" ? (
    <Badge className="bg-rose-600 text-white">
      <Radio className="size-3" /> Live{inherited ? "" : " (override)"}
    </Badge>
  ) : (
    <Badge variant="outline">
      <FlaskConical className="size-3" /> Test{inherited ? "" : " (override)"}
    </Badge>
  );
}

function SendingPanel({ workspace, perms }: { workspace: Workspace; perms: Perms }) {
  const router = useRouter();
  const [mode, setMode] = useState(workspace.mode);
  const [numbers, setNumbers] = useState(workspace.testNumbers.replace(/,\s*/g, "\n"));
  const [pending, startTransition] = useTransition();
  const dirty =
    mode !== workspace.mode ||
    numbers.trim() !== workspace.testNumbers.replace(/,\s*/g, "\n").trim();

  return (
    <section className="rounded-xl border p-4" aria-label="Sending">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Where messages go</h3>
          <p className="text-muted-foreground text-sm">
            <b>Test</b> sends a small sample to the numbers below instead of patients. <b>Live</b>{" "}
            messages real patients and needs a clinical sign-off.
            {!workspace.clinicalMessagingEnabled &&
              " Clinical messaging is not enabled yet, so clinical programmes cannot go Live."}
          </p>
        </div>
        <ModeBadge mode={workspace.mode} inherited />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_14rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="test-numbers">Internal test numbers (one per line)</Label>
          <Textarea
            id="test-numbers"
            rows={3}
            value={numbers}
            onChange={(e) => setNumbers(e.target.value)}
            disabled={!perms.signOff}
            placeholder="+971 50 000 0000"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Workspace default</Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as "test" | "live")}
            disabled={!perms.signOff}
          >
            <SelectTrigger aria-label="Workspace default send mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="test">Test (safe)</SelectItem>
              <SelectItem value="live">Live (real patients)</SelectItem>
            </SelectContent>
          </Select>
          <Button
            disabled={!perms.signOff || pending || !dirty}
            onClick={() => {
              if (
                mode === "live" &&
                !confirm(
                  "Switch the workspace default to LIVE? Programmes without their own override will message real patients once their other checks pass.",
                )
              )
                return;
              startTransition(async () => {
                const r = await saveSendingSettings({ mode, test_numbers: numbers });
                if (r.ok) {
                  toast.success(r.message);
                  router.refresh();
                } else toast.error(r.error);
              });
            }}
          >
            {pending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Sign off and save
          </Button>
          {!perms.signOff && (
            <p className="text-muted-foreground text-xs">
              Only people who can sign off clinical settings can change this.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ProgrammeDrawer({
  p,
  templates,
  workspace,
  perms,
}: {
  p: ProgrammeVM;
  templates: TemplateOption[];
  workspace: Workspace;
  perms: Perms;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(p.status);
  const [mode, setMode] = useState<string>(p.send_mode_override ?? "default");
  const [cron, setCron] = useState(p.cron_expression ?? "");
  const [max, setMax] = useState(p.max_per_run);
  const [sample, setSample] = useState<number>(
    typeof p.config.test_sample_size === "number" ? p.config.test_sample_size : 5,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    after?: () => void,
  ) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast.success(r.message);
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });

  const segments = [
    ...new Set([
      ...p.templates.map((t) => t.segment_key),
      ...Object.keys(preview?.bySegment ?? {}).filter((s) => s !== "(no segment)"),
    ]),
  ].sort();

  return (
    <div className="flex flex-col gap-5 p-4">
      <SheetHeader className="p-0">
        <SheetTitle>{p.name}</SheetTitle>
        <SheetDescription>
          {KIND_LABELS[p.kind] ?? p.kind}. Who is included is decided by a fixed rule (
          {p.eligibility_view ?? "not defined yet"}); thresholds come from signed-off clinical
          settings.
        </SheetDescription>
      </SheetHeader>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Status</Label>
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
            disabled={!perms.manage}
          >
            <SelectTrigger aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Sending</Label>
          <Select value={mode} onValueChange={setMode} disabled={!perms.manage}>
            <SelectTrigger aria-label="Send mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                Workspace default ({workspace.mode === "live" ? "Live" : "Test"})
              </SelectItem>
              <SelectItem value="test">Always Test</SelectItem>
              <SelectItem value="live" disabled={!perms.signOff}>
                Live (needs sign-off)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cron">Schedule (Dubai time)</Label>
          <Input
            id="cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="font-mono text-xs"
            disabled={!perms.manage}
          />
          <p className="text-muted-foreground text-xs">
            {cron ? describeSchedule(formFromCron(cron)) : "Not scheduled"} · minute hour day month
            weekday
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="max">Max per run</Label>
            <Input
              id="max"
              type="number"
              min={1}
              max={1000}
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
              disabled={!perms.manage}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sample">Test sample</Label>
            <Input
              id="sample"
              type="number"
              min={0}
              max={50}
              value={sample}
              onChange={(e) => setSample(Number(e.target.value))}
              disabled={!perms.manage}
            />
          </div>
        </div>
        <div className="sm:col-span-2">
          <Button
            disabled={!perms.manage || pending}
            onClick={() =>
              run(() =>
                saveProgramme(p.id, {
                  status,
                  cron_expression: cron.trim() || null,
                  max_per_run: max,
                  send_mode_override: mode === "default" ? null : (mode as "test" | "live"),
                  test_sample_size: sample,
                }),
              )
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Save />} Save programme
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold">Who would be picked up</h4>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await previewProgramme(p.id);
                if (r.ok) setPreview(r.data);
                else toast.error(r.error);
              })
            }
          >
            <Eye /> Preview
          </Button>
        </div>
        {preview ? (
          <div className="text-sm">
            <p>
              <b>{preview.eligible}</b> eligible right now (counts only; no names are shown here).
            </p>
            {preview.note && <p className="text-amber-700 dark:text-amber-400">{preview.note}</p>}
            {Object.entries(preview.bySegment).length > 0 && (
              <ul className="text-muted-foreground mt-1">
                {Object.entries(preview.bySegment).map(([s, n]) => (
                  <li key={s}>
                    {s}: {n}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Run a preview to see how many people the rule includes today.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="font-semibold">Template for each group</h4>
        <p className="text-muted-foreground text-xs">
          A group with no approved template is skipped and listed as “no template”. There is no
          fallback template on purpose.
        </p>
        {segments.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This programme sends one template to everyone.
          </p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead>Template</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(segments.length ? segments : ["*"]).map((seg) => {
              const row = p.templates.find((t) => t.segment_key === seg);
              return (
                <TableRow key={seg}>
                  <TableCell className="text-sm">
                    {seg === "*" ? "Everyone" : seg}
                    {row?.legacy && (
                      <div className="text-muted-foreground text-xs">
                        Sanoflow template {row.legacy}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={row?.wa_template_id ?? "none"}
                      disabled={!perms.mapTemplates || pending}
                      onValueChange={(v) =>
                        run(() =>
                          saveTemplateMap(p.id, {
                            segment_key: seg,
                            wa_template_id: v === "none" ? null : v,
                            active: true,
                          }),
                        )
                      }
                    >
                      <SelectTrigger aria-label={`Template for ${seg}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No template (skip)</SelectItem>
                        {templates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                            {t.status !== "APPROVED" ? ` (${t.status})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      {p.weekly.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold">Recent weeks</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Week of</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Replied</TableHead>
                <TableHead>Booked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.weekly.map((w) => (
                <TableRow key={`${w.week_start}-${w.send_mode}`}>
                  <TableCell>{w.week_start}</TableCell>
                  <TableCell>{w.send_mode}</TableCell>
                  <TableCell className="tabular-nums">{w.sent}</TableCell>
                  <TableCell className="tabular-nums">{w.replied}</TableCell>
                  <TableCell className="tabular-nums">{w.booked}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {p.last_run_at && (
        <p className="text-muted-foreground text-xs">
          Last run {new Date(p.last_run_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}
        </p>
      )}
    </div>
  );
}
