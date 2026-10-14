import Link from "next/link";

import { KpiTile } from "@/components/charts/kpi-tile";
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
import { can, canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { ROOM_KIND_LABEL, type RoomKind } from "@/lib/capacity/rooms";
import { loadCapacity, loadCapacityScope } from "@/lib/capacity/server";
import { todayIn } from "@/lib/finance/action-support";
import { monthParam } from "@/lib/finance/doctor-performance";
import { latestReportMonth } from "@/lib/finance/doctor-performance-server";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { LinkKeyForm, OpenHoursForm, UnlinkButton } from "./forms";

export const metadata = { title: "Capacity" };
export const dynamic = "force-dynamic";

type Search = { month?: string; location?: string };

const num = "text-right tabular-nums whitespace-nowrap";
const hrs = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const NEEDS_UNITE = "Needs Unite appointments";
// Room hours come from the staff rota (rota_shifts, PR #72) once its room is linked to a room here.
const NEEDS_ROTA = "Needs the rota (PR #72)";

export default async function CapacityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.revenue.view");
  const sp = await searchParams;
  const thisMonth = `${todayIn(member.org.timezone).slice(0, 7)}-01`;

  const admin = createAdminClient(); // service role AFTER the permission check
  const scope = await loadCapacityScope(admin, member, sp.location);
  const month =
    monthParam(sp.month) ??
    (await latestReportMonth(admin, member.orgId, scope.allowedCodes)) ??
    thisMonth;
  const cap = await loadCapacity(admin, member.orgId, scope, month);
  await recordAccess(admin, member, { entity: "finance_invoice", action: "list" });

  // Billing and the Medical Director get no cost data (F8): room cost only with a cost or profit permission.
  const seeCost = canAny(member, ["finance.costs.view", "finance.profit.view"]);
  const canLink = can(member, "finance.reference.manage");
  const title = monthTitle(month);
  const r = cap.report;
  const t = r.totals;
  const chosenName = scope.locations.find((l) => l.id === scope.chosen)?.name ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Capacity"
        description="Doctors' available hours for a month set against Unite revenue (revenue per available hour), and the rooms of each branch. Activity measures, not a judgement of clinical quality."
      >
        {can(member, "rooms.manage") && (
          <Button asChild variant="outline">
            <Link href="/settings/rooms">Rooms</Link>
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
      </form>

      {!scope.revenueAvailable && (
        <Alert>
          <AlertTitle>Revenue is not shown for {chosenName ?? "this branch"}</AlertTitle>
          <AlertDescription>
            The branch has no finance branch code, so its Unite revenue cannot be told apart from
            other branches. Hours and rooms are still shown.
          </AlertDescription>
        </Alert>
      )}
      {scope.revenueAvailable && !cap.hasRevenueData && (
        <Alert>
          <AlertTitle>No Unite report data for {title} yet</AlertTitle>
          <AlertDescription>
            Revenue comes from the Unite Daily Collection report (Finance, Upload). Hours and rooms
            are shown without it.
          </AlertDescription>
        </Alert>
      )}
      {scope.revenueAvailable && cap.hasRevenueData && !cap.coverage.full && (
        <Alert>
          <AlertTitle>Part of the month is missing</AlertTitle>
          <AlertDescription>
            {title} is only partly covered by Unite report uploads ({cap.coverage.label}), while the
            hours cover the whole month. Revenue per hour reads low until the month is complete.
          </AlertDescription>
        </Alert>
      )}

      <section aria-label="Headline figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Doctors' available hours"
          value={Math.round(t.availableHours)}
          hint={`${cap.openDays} open days in ${title}`}
        />
        <KpiTile
          label="Revenue per available hour (AED)"
          value={t.revenuePerAvailableHour === null ? null : Math.round(t.revenuePerAvailableHour)}
          hint="Linked doctors with working hours"
        />
        <KpiTile label="Room occupancy (%)" value={null} hint={NEEDS_ROTA} />
        <KpiTile label="Appointment utilisation" value={null} hint={NEEDS_UNITE} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Doctors, {title}</CardTitle>
          <CardDescription>
            Available hours are working hours on open days minus weekly blocks and one-off blocks
            (leave), the same time the booking drawer would offer. Revenue is Unite net billing for
            the Unite doctor linked to the Pulse doctor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r.doctors.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No doctor has working hours or linked revenue in this scope.
            </p>
          ) : (
            <Table>
              <caption className="sr-only">Available hours and revenue per doctor, {title}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Doctor</TableHead>
                  <TableHead className="text-right">Available hours</TableHead>
                  <TableHead className="text-right">Revenue (AED)</TableHead>
                  <TableHead className="text-right">Revenue / available hour</TableHead>
                  <TableHead>Booked vs available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.doctors.map((d) => (
                  <TableRow key={d.specialistId}>
                    <TableHead scope="row" className="text-foreground font-normal">
                      {d.name}
                    </TableHead>
                    <TableCell className={num}>{hrs(d.availableHours)}</TableCell>
                    <TableCell className={num}>
                      {d.revenue === null ? (
                        <span className="text-muted-foreground">
                          {scope.revenueAvailable ? "Not linked" : "—"}
                        </span>
                      ) : (
                        money(d.revenue)
                      )}
                    </TableCell>
                    <TableCell className={num}>{money(d.revenuePerAvailableHour)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{NEEDS_UNITE}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rooms, {title}</CardTitle>
          <CardDescription>
            Open hours are {hrs(cap.openHoursPerDay)} hours on each of {cap.openDays} open days.
            Rota hours, occupancy and revenue per room-hour need the staff rota (PR #72) with its
            rooms linked to these rooms.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r.rooms.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No rooms in this scope yet
              {can(member, "rooms.manage") ? (
                <>
                  {" "}
                  (add them under{" "}
                  <Link className="text-primary underline" href="/settings/rooms">
                    Settings, Rooms
                  </Link>
                  ).
                </>
              ) : (
                "."
              )}
            </p>
          ) : (
            <Table>
              <caption className="sr-only">Rooms and their open hours, {title}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Room</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Open hours</TableHead>
                  <TableHead>Rota hours, occupancy, revenue / room-hour</TableHead>
                  {seeCost && <TableHead className="text-right">Monthly cost (AED)</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.rooms.map((room) => (
                  <TableRow key={room.id}>
                    <TableHead scope="row" className="text-foreground font-normal">
                      {room.name}
                      <span className="text-muted-foreground block text-xs">
                        {ROOM_KIND_LABEL[room.kind as RoomKind] ?? room.kind}
                      </span>
                    </TableHead>
                    <TableCell>{room.locationName}</TableCell>
                    <TableCell className={num}>{hrs(room.openHours)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{NEEDS_ROTA}</TableCell>
                    {seeCost && (
                      <TableCell className={num}>
                        {room.monthlyCost === null ? (
                          <span className="text-muted-foreground">Cost unknown</span>
                        ) : (
                          money(room.monthlyCost)
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {scope.revenueAvailable && (cap.unlinked.length > 0 || cap.links.length > 0) && (
        <Card id="links">
          <CardHeader>
            <CardTitle className="text-base">Unite doctors and Pulse doctors</CardTitle>
            <CardDescription>
              The Unite report names doctors its own way. Link each Unite doctor to the Pulse doctor
              whose hours they match; a Pulse doctor may have several Unite spellings.
              {!canLink && " Finance staff with reference data rights make the links."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {cap.unlinked.length > 0 && (
              <section aria-label="Unite doctors not linked" className="flex flex-col gap-3">
                <h3 className="text-sm font-medium">Not linked yet ({cap.unlinked.length})</h3>
                <ul className="flex flex-col gap-3">
                  {cap.unlinked.map((u) => (
                    <li key={u.doctorKey} className="flex flex-col gap-1 rounded-md border p-3">
                      <span className="text-sm">
                        {u.doctorName}
                        <span className="text-muted-foreground">
                          {" "}
                          · AED {money(u.revenue)} in {title}
                        </span>
                      </span>
                      {canLink && (
                        <LinkKeyForm
                          doctorKey={u.doctorKey}
                          doctorName={u.doctorName}
                          specialists={cap.specialists}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {cap.links.length > 0 && (
              <section aria-label="Linked doctors" className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Linked</h3>
                <ul className="flex flex-col gap-1">
                  {cap.links.map((l) => (
                    <li
                      key={l.doctorKey}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span>
                        {l.doctorName} <span className="text-muted-foreground">→</span>{" "}
                        {l.specialistName}
                      </span>
                      {canLink && <UnlinkButton doctorKey={l.doctorKey} label={l.doctorName} />}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </CardContent>
        </Card>
      )}

      {can(member, "finance.targets.manage") && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Room opening hours</CardTitle>
            <CardDescription>
              Branches have no opening hours in Pulse yet, so room open hours (and occupancy, once
              the rota is linked) use this number of hours on every open day.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OpenHoursForm hours={cap.openHoursPerDay} />
          </CardContent>
        </Card>
      )}

      <footer className="text-muted-foreground flex flex-col gap-1 text-xs">
        <span>
          Appointment utilisation (booked against available minutes) waits for the Unite appointment
          feed: until appointments flow from Unite, Pulse sees only the bookings made in Pulse.
        </span>
        {t.revenue !== null && (
          <span>
            Linked revenue for {title}
            {chosenName ? ` (${chosenName})` : ""}: AED {money(t.revenue)}.
          </span>
        )}
      </footer>
    </div>
  );
}
