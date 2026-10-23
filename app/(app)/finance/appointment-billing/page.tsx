import Link from "next/link";

import { KpiTile } from "@/components/charts/kpi-tile";
import { CappedNote, EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { loadCapacity, loadCapacityScope } from "@/lib/capacity/server";
import { todayIn } from "@/lib/finance/action-support";
import { REASON_LABEL, STATUS_LABEL } from "@/lib/finance/appointment-billing";
import {
  latestAppointmentMonth,
  loadAppointmentBilling,
  type ApptLine,
} from "@/lib/finance/appointment-billing-server";
import { monthParam } from "@/lib/finance/doctor-performance";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { AppointmentUpload } from "./forms";

export const metadata = { title: "Appointments and invoices" };
export const dynamic = "force-dynamic";

type Search = { month?: string; location?: string };

const LIST_CAP = 200;
const num = "text-right tabular-nums whitespace-nowrap";
const int = (v: number) => v.toLocaleString("en-GB");
const hrs = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const pct = (v: number | null) =>
  v === null ? "—" : `${v.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;

const addMonths = (month: string, k: number) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
};

export default async function AppointmentBillingPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.revenue.view");
  const sp = await searchParams;
  const thisMonth = `${todayIn(member.org.timezone).slice(0, 7)}-01`;

  const admin = createAdminClient(); // service role AFTER the permission check
  const scope = await loadCapacityScope(admin, member, sp.location);
  const month =
    monthParam(sp.month) ?? (await latestAppointmentMonth(admin, member.orgId)) ?? thisMonth;
  const capacity = await loadCapacity(admin, member.orgId, scope, month);
  const r = await loadAppointmentBilling(admin, member.orgId, scope, month, capacity);
  await recordAccess(admin, member, { entity: "finance_invoice", action: "list" });

  const title = monthTitle(month);
  const canImport = can(member, "finance.revenue.import");
  const names = new Map(scope.locations.map((l) => [l.branchCode ?? "", l.name]));
  const branchName = (code: string | null) =>
    code === null ? "Unknown branch" : (names.get(code) ?? code);
  const q = (m: string) =>
    new URLSearchParams({
      month: m.slice(0, 7),
      ...(scope.chosen ? { location: scope.chosen } : {}),
    });
  const excel = `/api/finance/appointment-billing?${q(month)}`;
  const c = r.counts;
  const chosenName = scope.locations.find((l) => l.id === scope.chosen)?.name ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Appointments and invoices"
        description="Unite appointments for a month set against Unite invoices: seen but not billed, billed but not seen, and how much of each doctor's and room's time was booked. Review prompts, not proof."
      >
        {r.hasAppointments && (
          <Button asChild variant="outline">
            <a href={excel}>Download Excel</a>
          </Button>
        )}
      </PageHeader>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Month</span>
          <Input name="month" type="month" defaultValue={month.slice(0, 7)} className="w-44" />
        </label>
        {scope.locations.length > 1 && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Branch</span>
            <select
              name="location"
              defaultValue={scope.chosen ?? "all"}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="all">All your branches</option>
              {scope.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="secondary">
          Show
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/finance/appointment-billing?${q(addMonths(month, -1))}`}>
            Previous month
          </Link>
        </Button>
        {month < thisMonth && (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/finance/appointment-billing?${q(addMonths(month, 1))}`}>Next month</Link>
          </Button>
        )}
      </form>

      {canImport && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload the Unite appointment export</CardTitle>
            <CardDescription>
              When the Unite appointment sync is on, each finished day arrives on its own overnight
              and no file is needed. Use a file for days before that, or to correct a day. The
              newest rows for a day and clinic win, from a file or from Unite; nothing is deleted.
              Needs the Unite invoices to be in Pulse to tell what was billed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AppointmentUpload />
          </CardContent>
        </Card>
      )}

      {!scope.revenueAvailable && (
        <Alert>
          <AlertTitle>Appointments are not shown for {chosenName ?? "this branch"}</AlertTitle>
          <AlertDescription>
            The branch has no finance branch code, so its appointments cannot be told apart from
            other branches. Set it under Settings, Clinic and appointments, Branches.
          </AlertDescription>
        </Alert>
      )}

      {scope.revenueAvailable && !r.hasAppointments && (
        <EmptyState
          title={`No Unite appointments for ${title} yet`}
          description={
            canImport
              ? "Finished days arrive overnight once the Unite appointment sync is on, or upload the Unite appointment export above. The figures appear here once a day is in."
              : "Finished days arrive overnight once the Unite appointment sync is on, or Finance uploads the Unite appointment export on this page."
          }
        />
      )}

      {scope.revenueAvailable && r.hasAppointments && (
        <>
          {!r.coverage.full && (
            <Alert>
              <AlertTitle>Part of the month is missing</AlertTitle>
              <AlertDescription>
                {title} is only partly covered by appointment uploads ({r.coverage.label}). Counts
                cover those dates only, while available hours cover the whole month, so utilisation
                reads low until the month is complete.
              </AlertDescription>
            </Alert>
          )}
          {r.invoiceWindow === null ? (
            <Alert>
              <AlertTitle>No Unite invoices for {title}</AlertTitle>
              <AlertDescription>
                Pulse holds no invoices for this month, so what was billed cannot be judged and
                nothing is listed as not billed. Utilisation is still shown.
              </AlertDescription>
            </Alert>
          ) : (
            c.not_judged > 0 && (
              <Alert>
                <AlertTitle>Some days have no invoice data</AlertTitle>
                <AlertDescription>
                  Invoices in Pulse cover {r.invoiceWindow.from} to {r.invoiceWindow.to}.{" "}
                  {int(c.not_judged)} honoured appointment(s) with no invoice fall outside those
                  days and are not judged.
                </AlertDescription>
              </Alert>
            )
          )}
          {r.truncated && (
            <Alert variant="destructive">
              <AlertTitle>Too many rows to read in one go</AlertTitle>
              <AlertDescription>
                The month is larger than the page can read, so these figures are incomplete. Use the
                branch filter.
              </AlertDescription>
            </Alert>
          )}

          <section
            aria-label="Headline figures"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <KpiTile
              label="Seen and billed"
              value={c.seen_billed}
              hint={`${int(c.total)} appointments in ${title}`}
            />
            <KpiTile
              label="Seen, not billed"
              value={c.seen_not_billed}
              hint={c.seen_not_billed === 0 ? "Nothing to chase" : "Honoured, no invoice found"}
            />
            <KpiTile
              label="Billed, not seen"
              value={c.billed_not_seen}
              hint={c.billed_not_seen === 0 ? "Nothing to check" : "Invoice, but not honoured"}
            />
            <KpiTile
              label="Needs review"
              value={c.review + r.invoicesNotInFile.length}
              hint={`Still open: ${int(c.open)}; cancelled: ${int(c.cancelled)}`}
            />
          </section>

          <ApptCard
            title={`Seen, not billed, ${title}`}
            description="Honoured appointments with no invoice by appointment id, or by PIN, doctor and day. A cancelled appointment is never listed here."
            lines={r.seenNotBilled}
            branchName={branchName}
            invoiceColumn={false}
            empty="Every honoured appointment in the covered days has an invoice."
          />
          <ApptCard
            title={`Billed, not seen, ${title}`}
            description="An invoice is tied to the appointment but Unite does not show it as honoured (cancelled, or still confirmed or awaiting confirmation)."
            lines={r.billedNotSeen}
            branchName={branchName}
            invoiceColumn
            empty="Every invoiced appointment is honoured."
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Needs review, {title}</CardTitle>
              <CardDescription>
                Never guessed: an appointment id that appears twice, several appointments sharing a
                PIN, doctor and day, and invoices that name an appointment the files do not hold. An
                invoice with no appointment id (a direct invoice) is valid and is not listed.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {r.review.length === 0 && r.invoicesNotInFile.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing to review.</p>
              ) : (
                <>
                  {r.review.length > 0 && (
                    <Table>
                      <caption className="sr-only">Appointments that need review, {title}</caption>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Appointment ID</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Doctor</TableHead>
                          <TableHead>Branch</TableHead>
                          <TableHead>Why</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.review.slice(0, LIST_CAP).map((l, i) => (
                          <TableRow key={`${l.appointmentId}-${i}`}>
                            <TableCell className="tabular-nums">{l.appointmentId}</TableCell>
                            <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                            <TableCell>{l.doctorName}</TableCell>
                            <TableCell>{branchName(l.branch)}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {l.reason ? REASON_LABEL[l.reason] : ""}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  {r.review.length > LIST_CAP && (
                    <CappedNote shown={LIST_CAP} total={r.review.length} />
                  )}
                  {r.invoicesNotInFile.length > 0 && (
                    <Table>
                      <caption className="sr-only">
                        Invoices whose appointment is not in the files, {title}
                      </caption>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Invoice</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Appointment ID on the invoice</TableHead>
                          <TableHead>Branch</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.invoicesNotInFile.slice(0, LIST_CAP).map((i) => (
                          <TableRow key={i.invoiceNo}>
                            <TableCell>{i.invoiceNo}</TableCell>
                            <TableCell className="whitespace-nowrap">{i.date}</TableCell>
                            <TableCell className="tabular-nums">{i.appointmentId}</TableCell>
                            <TableCell>{branchName(i.branch)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  {r.invoicesNotInFile.length > LIST_CAP && (
                    <CappedNote shown={LIST_CAP} total={r.invoicesNotInFile.length} />
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Doctors, {title}</CardTitle>
              <CardDescription>
                Booked = appointments that are not cancelled; seen = honoured. Utilisation is booked
                (or seen) hours against the doctor&apos;s available hours (the Capacity page&apos;s
                number, through the doctor link on the Doctors page).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <UtilisationTable
                caption={`Utilisation per doctor, ${title}`}
                first="Doctor"
                rows={r.doctors.map((d) => ({ key: d.key, label: d.name, u: d }))}
              />
              {r.doctorsWithoutHours > 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                  {int(r.doctorsWithoutHours)} doctor(s) show no percentage: they are not linked to
                  a Pulse doctor
                  {can(member, "settings.manage") ? " (link them on the Doctors page)" : ""} or have
                  no working hours.
                </p>
              )}
              {r.noDurationRows > 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                  {int(r.noDurationRows)} booked appointment(s) have no length in the file; a doctor
                  or room with such an appointment shows no hours.
                </p>
              )}
            </CardContent>
          </Card>

          {r.hasRooms && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Rooms, {title}</CardTitle>
                <CardDescription>
                  Room hours against the room&apos;s open hours (open days times the opening hours
                  on the Capacity page). A room name that is not under Settings, Rooms for that
                  branch shows hours but no percentage.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UtilisationTable
                  caption={`Utilisation per room, ${title}`}
                  first="Room"
                  rows={r.rooms.map((d) => ({
                    key: d.key,
                    label: `${d.room} (${branchName(d.branch)})`,
                    u: d,
                  }))}
                  availableLabel="Open hours"
                />
              </CardContent>
            </Card>
          )}

          <footer className="text-muted-foreground flex flex-col gap-1 text-xs">
            <span>
              Appointments in {title}
              {chosenName ? ` (${chosenName})` : ""}: {int(c.total)}.{" "}
              {r.unknownBranchRows > 0 &&
                `${int(r.unknownBranchRows)} have a clinic that is not mapped to a branch (Finance, Reference data).`}
            </span>
          </footer>
        </>
      )}
    </div>
  );
}

function ApptCard({
  title,
  description,
  lines,
  branchName,
  invoiceColumn,
  empty,
}: {
  title: string;
  description: string;
  lines: ApptLine[];
  branchName: (code: string | null) => string;
  invoiceColumn: boolean;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {title} <span className="text-muted-foreground font-normal">({int(lines.length)})</span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">{empty}</p>
        ) : (
          <>
            <Table>
              <caption className="sr-only">{title}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Appointment ID</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Doctor</TableHead>
                  <TableHead>Branch</TableHead>
                  {invoiceColumn && <TableHead>Invoice</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.slice(0, LIST_CAP).map((l, i) => (
                  <TableRow key={`${l.appointmentId}-${i}`}>
                    <TableCell className="tabular-nums">{l.appointmentId}</TableCell>
                    <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                    <TableCell>{STATUS_LABEL[l.status]}</TableCell>
                    <TableCell>{l.doctorName}</TableCell>
                    <TableCell>{branchName(l.branch)}</TableCell>
                    {invoiceColumn && (
                      <TableCell>
                        {l.invoiceNos.join(", ")}
                        {l.basis === "pin_doctor_day" && (
                          <span className="text-muted-foreground block text-xs">
                            tied by PIN, doctor and day
                          </span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {lines.length > LIST_CAP && <CappedNote shown={LIST_CAP} total={lines.length} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UtilisationTable({
  caption,
  first,
  rows,
  availableLabel = "Available hours",
}: {
  caption: string;
  first: string;
  rows: {
    key: string;
    label: string;
    u: {
      booked: number;
      seen: number;
      cancelled: number;
      bookedHours: number | null;
      seenHours: number | null;
      availableHours: number | null;
      bookedPct: number | null;
      seenPct: number | null;
    };
  }[];
  availableLabel?: string;
}) {
  if (rows.length === 0)
    return <p className="text-muted-foreground text-sm">No appointments in this scope.</p>;
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{first}</TableHead>
          <TableHead className="text-right">Booked</TableHead>
          <TableHead className="text-right">Seen</TableHead>
          <TableHead className="text-right">Cancelled</TableHead>
          <TableHead className="text-right">Booked hours</TableHead>
          <TableHead className="text-right">Seen hours</TableHead>
          <TableHead className="text-right">{availableLabel}</TableHead>
          <TableHead className="text-right">Booked %</TableHead>
          <TableHead className="text-right">Seen %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ key, label, u }) => (
          <TableRow key={key}>
            <TableHead scope="row" className="text-foreground font-normal">
              {label}
            </TableHead>
            <TableCell className={num}>{int(u.booked)}</TableCell>
            <TableCell className={num}>{int(u.seen)}</TableCell>
            <TableCell className={num}>{int(u.cancelled)}</TableCell>
            <TableCell className={num}>{hrs(u.bookedHours)}</TableCell>
            <TableCell className={num}>{hrs(u.seenHours)}</TableCell>
            <TableCell className={num}>{hrs(u.availableHours)}</TableCell>
            <TableCell className={num}>{pct(u.bookedPct)}</TableCell>
            <TableCell className={num}>{pct(u.seenPct)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
