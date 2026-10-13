import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import {
  monthOf,
  pctLabel,
  tone,
  type DoctorSection,
  type FlashSummary,
  type GridComparison,
  type LineResult,
  type Measure,
  type SalesGrid,
} from "@/lib/finance/flash";
import { loadFlashReport } from "@/lib/finance/flash-server";
import { monthTitle, sheetDate } from "@/lib/finance/flash-xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Daily flash" };
export const dynamic = "force-dynamic";

type Search = { date?: string; view?: string };
const VIEWS = [
  { key: "day", label: "Daily summary" },
  { key: "month", label: "Month to date" },
  { key: "grid", label: "Daily sales" },
] as const;
type View = (typeof VIEWS)[number]["key"];

/** Whole dirhams, negatives in brackets: the format of the clinic's sheets. */
function whole(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const s = Math.round(Math.abs(n)).toLocaleString("en-GB");
  return n < 0 && Math.round(Math.abs(n)) !== 0 ? `(${s})` : s;
}

function Tone({ v, children }: { v: number | null; children: React.ReactNode }) {
  const t = tone(v);
  return (
    <span
      className={cn(
        "tabular-nums",
        t === "good" && "text-emerald-600 dark:text-emerald-400",
        t === "bad" && "text-destructive",
      )}
    >
      {children}
    </span>
  );
}

const num = "text-right tabular-nums";

function KpiTable({ s }: { s: FlashSummary }) {
  const row = (label: string, m: Measure, fmt: (n: number | null) => string = whole) => (
    <TableRow>
      <TableCell>{label}</TableCell>
      <TableCell className={num}>{m.actual === 0 && m.target === null ? "" : fmt(m.actual)}</TableCell>
      <TableCell className={num}>{fmt(m.target)}</TableCell>
      <TableCell className={num}>
        <Tone v={m.variance}>{whole(m.variance)}</Tone>
      </TableCell>
      <TableCell className={num}>
        <Tone v={m.variancePct}>{pctLabel(m.variancePct)}</Tone>
      </TableCell>
    </TableRow>
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Key performance indicators</TableHead>
          <TableHead className="text-right">Actual</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead className="text-right">Variance</TableHead>
          <TableHead className="text-right">Variance %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {row("Net revenue", s.kpis.revenue)}
        {row("Patient volume", s.kpis.patients)}
        {row("ARPP (average revenue per patient)", s.kpis.arpp)}
      </TableBody>
    </Table>
  );
}

function LineRow({ l, strong }: { l: LineResult; strong?: boolean }) {
  return (
    <TableRow className={cn(strong && "bg-muted/50 font-semibold")}>
      <TableCell>
        {l.label}
        {l.code === "UNASSIGNED" && (
          <Badge variant="warning" className="ml-2">
            check settings
          </Badge>
        )}
      </TableCell>
      <TableCell className={num}>{whole(l.revenue.actual)}</TableCell>
      <TableCell className={num}>{whole(l.revenue.target)}</TableCell>
      <TableCell className={num}>
        <Tone v={l.revenue.variancePct}>{pctLabel(l.revenue.variancePct)}</Tone>
      </TableCell>
      <TableCell className={num}>{l.patients || ""}</TableCell>
      <TableCell className={num}>{whole(l.arpp)}</TableCell>
    </TableRow>
  );
}

function LinesTable({ s }: { s: FlashSummary }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Branch</TableHead>
          <TableHead className="text-right">Revenue (AED)</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead className="text-right">Variance</TableHead>
          <TableHead className="text-right">Patients</TableHead>
          <TableHead className="text-right">ARPP</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {s.lines.map((l) => (
          <LineRow key={l.code} l={l} />
        ))}
        <LineRow
          l={{
            ...s.coreTotal,
            label: s.otherLines.length > 0 ? "Total revenue (excl. separate lines)" : "Total revenue",
          }}
          strong
        />
        {s.otherLines.map((l) => (
          <LineRow key={l.code} l={l} />
        ))}
        {s.otherLines.length > 0 && (
          <TableRow className="font-semibold">
            <TableCell>Total revenue (all lines)</TableCell>
            <TableCell className={num}>{whole(s.grandTotal.revenue)}</TableCell>
            <TableCell />
            <TableCell />
            <TableCell className={num}>{s.grandTotal.patients || ""}</TableCell>
            <TableCell className={num}>{whole(s.grandTotal.arpp)}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function DoctorTable({ d, limit }: { d: DoctorSection; limit?: number }) {
  const rows = limit ? d.doctors.slice(0, limit) : d.doctors;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">Rank</TableHead>
          <TableHead>Doctor</TableHead>
          <TableHead className="text-right">Revenue</TableHead>
          <TableHead className="text-right">Patients</TableHead>
          <TableHead className="text-right">ARPP</TableHead>
          <TableHead className="text-right">% of total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-muted-foreground text-sm">
              No revenue.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => (
            <TableRow key={`${r.doctorId ?? r.name}`}>
              <TableCell className={num}>{r.rank}</TableCell>
              <TableCell>{r.name}</TableCell>
              <TableCell className={num}>{whole(r.revenue)}</TableCell>
              <TableCell className={num}>{r.patients}</TableCell>
              <TableCell className={num}>{whole(r.arpp)}</TableCell>
              <TableCell className={num}>{pctLabel(r.share)}</TableCell>
            </TableRow>
          ))
        )}
        {!limit && rows.length > 0 && (
          <TableRow className="bg-muted/50 font-semibold">
            <TableCell />
            <TableCell>Total</TableCell>
            <TableCell className={num}>{whole(d.total.revenue)}</TableCell>
            <TableCell className={num}>{d.total.patients}</TableCell>
            <TableCell className={num}>{whole(d.total.arpp)}</TableCell>
            <TableCell className={num}>{pctLabel(d.total.share)}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function Summary({ s, topDoctors }: { s: FlashSummary; topDoctors: number }) {
  const core = s.doctorSections.find((d) => d.code === "CORE");
  const others = s.doctorSections.filter((d) => d.code !== "CORE");
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Executive summary</CardTitle>
          </CardHeader>
          <CardContent>
            <KpiTable s={s} />
          </CardContent>
        </Card>
        {core && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top {topDoctors} performing doctors</CardTitle>
            </CardHeader>
            <CardContent>
              <DoctorTable d={core} limit={topDoctors} />
            </CardContent>
          </Card>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branch revenue performance</CardTitle>
        </CardHeader>
        <CardContent>
          <LinesTable s={s} />
        </CardContent>
      </Card>
      {core && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Doctor performance (all branches)</CardTitle>
          </CardHeader>
          <CardContent>
            <DoctorTable d={core} />
          </CardContent>
        </Card>
      )}
      {others.map((d) => (
        <Card key={d.code}>
          <CardHeader>
            <CardTitle className="text-base">Doctor performance ({d.label})</CardTitle>
          </CardHeader>
          <CardContent>
            <DoctorTable d={d} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ComparisonCard({ c, month, previousMonth, day }: { c: GridComparison; month: string; previousMonth: string; day: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {monthTitle(month)} against {monthTitle(previousMonth)}, days 1 to {Number(day.slice(8, 10))}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Line</TableHead>
              <TableHead className="text-right">{monthTitle(month)}</TableHead>
              <TableHead className="text-right">{monthTitle(previousMonth)}</TableHead>
              <TableHead className="text-right">Change</TableHead>
              <TableHead className="text-right">Change %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.rows.map((r) => (
              <TableRow key={r.code}>
                <TableCell>{r.label}</TableCell>
                <TableCell className={num}>{whole(r.current)}</TableCell>
                <TableCell className={num}>{whole(r.previous)}</TableCell>
                <TableCell className={num}>
                  <Tone v={r.change}>{whole(r.change)}</Tone>
                </TableCell>
                <TableCell className={num}>
                  <Tone v={r.changePct}>{pctLabel(r.changePct)}</Tone>
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/50 font-semibold">
              <TableCell>Total</TableCell>
              <TableCell className={num}>{whole(c.total.current)}</TableCell>
              <TableCell className={num}>{whole(c.total.previous)}</TableCell>
              <TableCell className={num}>
                <Tone v={c.total.change}>{whole(c.total.change)}</Tone>
              </TableCell>
              <TableCell className={num}>
                <Tone v={c.total.changePct}>{pctLabel(c.total.changePct)}</Tone>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Grid({ g }: { g: SalesGrid }) {
  const weekday = (iso: string) =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      new Date(`${iso}T00:00:00Z`).getUTCDay()
    ];
  const max = Math.max(1, ...g.days.map((d) => d.total));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily sales summary, {monthTitle(g.month)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex h-40 items-end gap-1" aria-label="Revenue per day">
          {g.days.map((d) => (
            <div
              key={d.date}
              className="bg-primary/70 flex-1 rounded-t"
              style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }}
              title={`${sheetDate(d.date)}: ${whole(d.total)}`}
            />
          ))}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Day</TableHead>
                {g.columns.map((c) => (
                  <TableHead key={c.code} className="text-right">
                    {c.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.days.map((d) => (
                <TableRow key={d.date}>
                  <TableCell className="tabular-nums">{sheetDate(d.date)}</TableCell>
                  <TableCell>{weekday(d.date)}</TableCell>
                  {d.values.map((v, i) => (
                    <TableCell key={g.columns[i].code} className={num}>
                      {v === 0 ? "-" : whole(v)}
                    </TableCell>
                  ))}
                  <TableCell className={cn(num, "font-medium")}>{whole(d.total)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/50 font-semibold">
                <TableCell>TOTAL</TableCell>
                <TableCell />
                {g.totals.map((v, i) => (
                  <TableCell key={g.columns[i].code} className={num}>
                    {whole(v)}
                  </TableCell>
                ))}
                <TableCell className={num}>{whole(g.grandTotal)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>%</TableCell>
                <TableCell />
                {g.shares.map((v, i) => (
                  <TableCell key={g.columns[i].code} className={num}>
                    {pctLabel(v)}
                  </TableCell>
                ))}
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function FlashPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.flash.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const yesterday = addDays(today, -1) ?? today;
  const day = sp.date && monthOf(sp.date) && sp.date <= today ? sp.date : yesterday;
  const view: View = VIEWS.some((v) => v.key === sp.view) ? (sp.view as View) : "day";

  const admin = createAdminClient(); // service role AFTER the permission check
  const report = await loadFlashReport(admin, member.orgId, day);
  const s = view === "month" ? report.monthToDate : report.daily;
  const link = (v: View, d = day) => `/finance/flash?${new URLSearchParams({ date: d, view: v })}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Daily flash"
        description={`${member.org.name}: revenue against target by branch, patient volume, ARPP and doctor rankings, for ${sheetDate(day)} and month to date. Built from Unite invoices; Chiro and leased units are reported on their own lines.`}
      >
        {can(member, "finance.targets.manage") && (
          <Button asChild variant="outline">
            <Link href="/finance/flash/settings">Targets and lines</Link>
          </Button>
        )}
        <Button asChild variant="outline">
          <a href={`/api/finance/flash?date=${day}`}>Download Excel</a>
        </Button>
      </PageHeader>

      <form className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="view" value={view} />
        <Input name="date" type="date" defaultValue={day} max={today} className="w-44" aria-label="Day" />
        <Button type="submit" variant="secondary">
          Show
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href={link(view, addDays(day, -1) ?? day)}>Previous day</Link>
        </Button>
        {day < today && (
          <Button asChild variant="ghost" size="sm">
            <Link href={link(view, addDays(day, 1) ?? day)}>Next day</Link>
          </Button>
        )}
      </form>

      <nav className="flex flex-wrap gap-2" aria-label="Report">
        {VIEWS.map((v) => (
          <Button key={v.key} asChild size="sm" variant={v.key === view ? "default" : "outline"}>
            <Link href={link(v.key)}>{v.label}</Link>
          </Button>
        ))}
      </nav>

      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <span>
          {view === "month"
            ? `Month to date: ${sheetDate(report.month)} to ${sheetDate(day)} (${report.monthToDate.days} days; targets are daily rates times the days elapsed).`
            : view === "day"
              ? `Day: ${sheetDate(day)}.`
              : `Every day of ${monthTitle(report.month)} up to ${sheetDate(day)}.`}{" "}
          Latest Unite data received:{" "}
          {report.lastReceivedAt
            ? new Date(report.lastReceivedAt).toLocaleString("en-GB", { timeZone: member.org.timezone })
            : "never"}
          .
        </span>
        {report.configuredLines === 0 && (
          <span>
            No reporting lines are set up yet, so each branch code is shown on its own line and nothing is reported
            separately.{" "}
            {can(member, "finance.targets.manage") && (
              <Link className="underline" href="/finance/flash/settings">
                Set up lines and targets
              </Link>
            )}
          </span>
        )}
      </div>

      {view !== "grid" && s.warnings.length > 0 && (
        <ul className="border-amber-500/40 bg-amber-500/5 flex list-disc flex-col gap-1 rounded-md border py-2 pr-3 pl-7 text-sm">
          {s.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {view === "grid" ? (
        <div className="flex flex-col gap-6">
          {report.comparison && report.previousGrid && (
            <ComparisonCard
              c={report.comparison}
              month={report.month}
              previousMonth={report.previousGrid.month}
              day={day}
            />
          )}
          <div className="grid gap-6 2xl:grid-cols-2">
            <Grid g={report.grid} />
            {report.previousGrid && <Grid g={report.previousGrid} />}
          </div>
        </div>
      ) : (
        <Summary s={s} topDoctors={report.topDoctors} />
      )}
    </div>
  );
}
