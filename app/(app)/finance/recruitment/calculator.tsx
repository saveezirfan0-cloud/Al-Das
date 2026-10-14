"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { money } from "@/lib/finance/format";
import {
  buildScenarioReport,
  CALENDAR_KIND_LABEL,
  CONTRACT_LABEL,
  CONTRACT_TYPES,
  INDIRECT_ITEMS,
  RECRUIT_BAND_LABEL,
  recruitmentInputsSchema,
  usesSalary,
  usesShare,
  VIABILITY_LABEL,
  type Benchmarks,
  type CalendarEvent,
  type ContractType,
  type RecruitmentInputs,
  type ScenarioReport,
  type Viability,
} from "@/lib/finance/recruitment";
import { cn } from "@/lib/utils";

import { saveScenario } from "./actions";

/**
 * The calculator. The browser works the scenario out live with the same pure engine the save action and the Excel
 * export use (lib/finance/recruitment.ts); saving sends only the inputs, and the server works the result out again.
 */

type Form = Record<string, string>;

const NUMBER_FIELDS = [
  "salary",
  "sharePct",
  "claimedRevenue",
  "equipmentRevenue",
  "staffRevenue",
  "conservativePct",
  "consumablesPct",
  "gatewayPct",
  "setupCost",
] as const;

function toForm(i: RecruitmentInputs): Form {
  const f: Form = {
    department: i.department ?? "",
    contractType: i.contractType,
    shareBasis: i.shareBasis,
    startMonth: i.startMonth ? i.startMonth.slice(0, 7) : "",
  };
  for (const k of NUMBER_FIELDS) f[k] = i[k] === 0 && !k.endsWith("Pct") ? "" : String(i[k]);
  for (const it of INDIRECT_ITEMS) {
    const v = i.indirect[it.key];
    f[`amount_${it.key}`] = v ? String(v.amount) : "";
    f[`months_${it.key}`] = v ? String(v.months) : "1";
  }
  return f;
}

function fromForm(f: Form): unknown {
  const n = (v: string | undefined) => (v ?? "").replace(/,/g, "").trim();
  const indirect: Record<string, { amount: string; months: string }> = {};
  for (const it of INDIRECT_ITEMS) {
    const amount = n(f[`amount_${it.key}`]);
    if (amount !== "" && Number(amount) !== 0)
      indirect[it.key] = { amount, months: n(f[`months_${it.key}`]) };
  }
  const out: Record<string, unknown> = {
    department: f.department ?? "",
    contractType: f.contractType,
    shareBasis: f.shareBasis,
    startMonth: f.startMonth ?? "",
    indirect,
  };
  for (const k of NUMBER_FIELDS) out[k] = n(f[k]);
  return out;
}

const pct = (v: number | null) =>
  v === null || !Number.isFinite(v)
    ? "—"
    : `${(v * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;

const VIABILITY_CLASS: Record<Viability, string> = {
  viable: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  marginal: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  not_viable: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
};

export function ViabilityBadge({ v }: { v: Viability }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent whitespace-nowrap", VIABILITY_CLASS[v])}
    >
      {VIABILITY_LABEL[v]}
    </Badge>
  );
}

function Row({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <TableRow className={cn(strong && "font-semibold")}>
      <TableHead scope="row" className="text-foreground h-auto py-1.5 font-normal">
        {label}
        {note && <span className="text-muted-foreground block text-xs">{note}</span>}
      </TableHead>
      <TableCell className="py-1.5 text-right whitespace-nowrap tabular-nums">{value}</TableCell>
    </TableRow>
  );
}

export function RecruitmentCalculator({
  initial,
  initialTitle,
  benchmarks,
  events,
  canSave,
}: {
  initial: RecruitmentInputs;
  initialTitle: string;
  benchmarks: Benchmarks;
  events: CalendarEvent[];
  canSave: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<Form>(() => toForm(initial));
  const [title, setTitle] = React.useState(initialTitle);
  const [pending, start] = React.useTransition();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const parsed = React.useMemo(() => recruitmentInputsSchema.safeParse(fromForm(form)), [form]);
  const report: ScenarioReport | null = React.useMemo(
    () => (parsed.success ? buildScenarioReport(parsed.data, benchmarks, events) : null),
    [parsed, benchmarks, events],
  );
  const type = form.contractType as ContractType;
  const departments = benchmarks.departments
    .map((d) => d.department)
    .filter((d): d is string => d !== null);
  if (form.department && !departments.includes(form.department)) departments.push(form.department);

  const save = () =>
    start(async () => {
      const res = await saveScenario({ title, inputs: fromForm(form) });
      if (res.ok) {
        toast.success(res.message ?? "Saved");
        if (res.data?.id) router.push(`/finance/recruitment?scenario=${res.data.id}`);
      } else toast.error(res.error);
    });

  const r = report?.result;
  const b = report?.benchmark;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Candidate and contract</CardTitle>
            <CardDescription>
              One pay model per contract type, as in the HR Contract Generator. GP and Gynaecology
              incentive profiles are not modelled.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Department"
              hint="Compared with this department's doctors in the Unite report."
            >
              <select className={selectClass} value={form.department} onChange={set("department")}>
                <option value="">Not chosen</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Contract type">
              <select
                className={selectClass}
                value={form.contractType}
                onChange={set("contractType")}
              >
                {CONTRACT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONTRACT_LABEL[t]}
                  </option>
                ))}
              </select>
            </Field>
            {usesSalary(type) && (
              <Field
                label="Monthly salary package (AED)"
                hint={
                  type === "salary_backed_share"
                    ? "Paid when it is higher than the share."
                    : "A fixed cost."
                }
              >
                <Input inputMode="decimal" value={form.salary} onChange={set("salary")} />
              </Field>
            )}
            {usesShare(type) && (
              <Field label="Doctor's share (%)">
                <Input inputMode="decimal" value={form.sharePct} onChange={set("sharePct")} />
              </Field>
            )}
            {(type === "share_only" || type === "salary_backed_share") && (
              <Field label="Share basis" className="sm:col-span-2">
                <select
                  className={selectClass}
                  value={form.shareBasis}
                  onChange={set("shareBasis")}
                >
                  <option value="net">Revenue after consumables and gateway</option>
                  <option value="gross">Gross revenue</option>
                </select>
              </Field>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly revenue</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="Claimed monthly revenue (AED)">
              <Input
                inputMode="decimal"
                value={form.claimedRevenue}
                onChange={set("claimedRevenue")}
              />
            </Field>
            <Field label="Conservative factor (%)" hint="Applied to the claimed revenue only.">
              <Input
                inputMode="decimal"
                value={form.conservativePct}
                onChange={set("conservativePct")}
              />
            </Field>
            <Field label="From their equipment (AED)">
              <Input
                inputMode="decimal"
                value={form.equipmentRevenue}
                onChange={set("equipmentRevenue")}
              />
            </Field>
            <Field label="From their nurse or coordinator (AED)">
              <Input inputMode="decimal" value={form.staffRevenue} onChange={set("staffRevenue")} />
            </Field>
            <Field label="Consumables (% of revenue)" hint="Usually 10 to 15 %.">
              <Input
                inputMode="decimal"
                value={form.consumablesPct}
                onChange={set("consumablesPct")}
              />
            </Field>
            <Field label="Payment gateway (% of revenue)">
              <Input inputMode="decimal" value={form.gatewayPct} onChange={set("gatewayPct")} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Indirect costs</CardTitle>
            <CardDescription>
              Enter each cost with the months it covers (1 = monthly, 12 = a yearly fee, 24 = a
              two-year visa); it is spread evenly. Lines marked * count in cost to company.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {INDIRECT_ITEMS.map((it) => (
              <div
                key={it.key}
                className="grid grid-cols-[minmax(0,1fr)_7.5rem_4.5rem] items-center gap-2"
              >
                <label htmlFor={`amount_${it.key}`} className="text-sm">
                  {it.label}
                  {it.doctor ? " *" : ""}
                </label>
                <Input
                  id={`amount_${it.key}`}
                  inputMode="decimal"
                  placeholder="AED"
                  value={form[`amount_${it.key}`]}
                  onChange={set(`amount_${it.key}`)}
                />
                <Input
                  aria-label={`${it.label}: months covered`}
                  inputMode="numeric"
                  value={form[`months_${it.key}`]}
                  onChange={set(`months_${it.key}`)}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Setup and start</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="One-off setup cost (AED)" hint="Recruitment, equipment, fit-out.">
              <Input inputMode="decimal" value={form.setupCost} onChange={set("setupCost")} />
            </Field>
            <Field label="Start month">
              <Input type="month" value={form.startMonth} onChange={set("startMonth")} />
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
        {!parsed.success || !r || !b ? (
          <Alert variant="destructive">
            <AlertTitle>Check the inputs</AlertTitle>
            <AlertDescription>
              {parsed.success ? "" : (parsed.error.issues[0]?.message ?? "")}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">Scenario result, per month</CardTitle>
                <ViabilityBadge v={r.viability} />
              </CardHeader>
              <CardContent>
                <Table>
                  <caption className="sr-only">Scenario result per month in AED</caption>
                  <TableBody>
                    <Row
                      label="Revenue"
                      note={`claimed ${money(r.revenue.claimed)} × ${pct(parsed.data.conservativePct / 100)}, plus equipment and nurse/coordinator`}
                      value={money(r.revenue.total)}
                      strong
                    />
                    <Row label="Consumables" value={money(-r.consumables)} />
                    <Row label="Payment gateway" value={money(-r.gateway)} />
                    <Row
                      label="Gross margin"
                      note={pct(r.grossMarginPct)}
                      value={money(r.grossMargin)}
                      strong
                    />
                    <Row
                      label="Doctor pay"
                      note={
                        r.shareAmount === null
                          ? "the salary"
                          : type === "salary_backed_share"
                            ? `${r.payBasis === "salary" ? "the salary" : "the share"} (share as calculated ${money(r.shareAmount)})`
                            : "the share"
                      }
                      value={money(-r.doctorPay)}
                    />
                    <Row
                      label="Net margin"
                      note={pct(r.netMarginPct)}
                      value={money(r.netMargin)}
                      strong
                    />
                    <Row label="Indirect costs" value={money(-r.indirectMonthly)} />
                    <Row
                      label="Profit"
                      note={pct(r.profitMarginPct)}
                      value={money(r.profitMonthly)}
                      strong
                    />
                    <Row label="Profit per year" value={money(r.profitAnnual)} />
                    <Row
                      label="Cost to company"
                      note={`${pct(r.ctcPctOfRevenue)} of revenue`}
                      value={money(r.costToCompany)}
                    />
                    <Row
                      label="Revenue per AED paid to the doctor"
                      value={r.revenuePerAedPaid === null ? "—" : r.revenuePerAedPaid.toFixed(2)}
                    />
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Breakeven</CardTitle>
                <CardDescription>
                  The monthly revenue at which profit reaches 0. Fixed costs are the indirect costs
                  plus the salary while it is the pay; consumables, gateway and a share move with
                  revenue.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    <Row
                      label="Breakeven revenue"
                      value={r.breakeven.revenue === null ? "Never" : money(r.breakeven.revenue)}
                      note={
                        r.breakeven.revenue === null
                          ? "What is left of each AED after variable costs and pay cannot cover the fixed costs."
                          : undefined
                      }
                      strong
                    />
                    <Row label="Fixed costs at breakeven" value={money(r.breakeven.fixedCosts)} />
                    <Row
                      label="Contribution margin ratio"
                      value={pct(r.breakeven.contributionRatio)}
                    />
                    <Row label="Breakeven % of revenue" value={pct(r.breakeven.pctOfRevenue)} />
                    <Row label="Safety margin" value={pct(r.breakeven.safetyMargin)} />
                    <Row
                      label="Months to recover the setup cost"
                      value={
                        r.monthsToRecover === null
                          ? "Never at this profit"
                          : String(r.monthsToRecover)
                      }
                    />
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Against the clinic&apos;s own doctors</CardTitle>
                <CardDescription>
                  Monthly net revenue per doctor from the Unite collection report ({b.months}{" "}
                  {b.months === 1 ? "full month" : "full months"}).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {b.reason && <p className="text-muted-foreground">{b.reason}</p>}
                {b.source !== "none" && (
                  <Table>
                    <TableBody>
                      <Row
                        label={
                          b.source === "department"
                            ? `${parsed.data.department}: median`
                            : "Clinic-wide: median"
                        }
                        value={money(b.median)}
                      />
                      <Row label="75th percentile" value={money(b.p75)} />
                      <Row
                        label="Doctor-months, doctors"
                        value={`${b.doctorMonths}, ${b.doctors}`}
                      />
                      <Row label="This scenario's revenue" value={money(r.revenue.total)} strong />
                      <Row label="Band" value={b.band ? RECRUIT_BAND_LABEL[b.band] : "—"} strong />
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Seasonal note</CardTitle>
                <CardDescription>
                  No seasonal factor is applied: the clinic&apos;s history is too short to measure
                  one. The events in the first three months are listed for judgement.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                {!report.season ? (
                  <p className="text-muted-foreground">Choose a start month.</p>
                ) : report.season.events.length === 0 ? (
                  <p className="text-muted-foreground">
                    No calendar events from {report.season.from} to {report.season.to}.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {report.season.events.map((e) => (
                      <li key={`${e.kind}-${e.startsOn}`}>
                        <span className="font-medium">{e.label}</span> (
                        {CALENDAR_KIND_LABEL[e.kind]}), {e.startsOn} to {e.endsOn}
                        {e.approximate && (
                          <span className="text-muted-foreground">
                            {" "}
                            (approximate until announced)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {canSave && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Save this scenario</CardTitle>
              <CardDescription>
                Use a role label such as &quot;Dermatologist, Jumeirah&quot;. Never type the
                candidate&apos;s name.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Title" className="flex-1">
                <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Button onClick={save} disabled={pending || !parsed.success || title.trim() === ""}>
                {pending && <Loader2 className="animate-spin" />} Save scenario
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
