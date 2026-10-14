import { ProvenanceStrip } from "@/components/finance/provenance-strip";
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
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import { doctorBasisNote, loadBlueprintSettings } from "@/lib/finance/blueprint-settings";
import { money } from "@/lib/finance/format";
import { loadFreshness } from "@/lib/finance/freshness";
import { buildProvenance } from "@/lib/finance/provenance";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Doctor activity" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type DoctorRow = {
  doctor_dha_id: string;
  doctor_name: string | null;
  department: string | null;
  invoices: number;
  patients: number;
  new_patients: number | null;
  returning_patients: number | null;
  revenue: number;
  completed_appointments: number | null;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export default async function DoctorsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.revenue.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const to = DATE.test(sp.to ?? "") ? sp.to! : today;
  const from = DATE.test(sp.from ?? "") ? sp.from! : (addDays(to, -29) ?? to);
  const [a, b] = from <= to ? [from, to] : [to, from];

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const [measures, settings, fresh] = await Promise.all([
    admin.rpc("fin_doctor_measures", { p_org_id: member.orgId, p_from: a, p_to: b }),
    loadBlueprintSettings(admin, member.orgId),
    loadFreshness(await createClient()),
  ]);
  const payload = (measures.data ?? {}) as {
    history_from?: string | null;
    rows?: Array<Record<string, unknown>>;
  };
  const rows: DoctorRow[] = (payload.rows ?? []).map((r) => ({
    doctor_dha_id: String(r.doctor_dha_id),
    doctor_name: (r.doctor_name as string | null) ?? null,
    department: (r.department as string | null) ?? null,
    invoices: Number(r.invoices ?? 0),
    patients: Number(r.patients ?? 0),
    new_patients: num(r.new_patients),
    returning_patients: num(r.returning_patients),
    revenue: Number(r.revenue ?? 0),
    completed_appointments: num(r.completed_appointments),
  }));
  const historyFrom = payload.history_from ?? null;
  const canSee = (k: string) => can(member, k);
  const prov = fresh
    ? buildProvenance({ ...fresh, captureEnabled: fresh.captureEnabledFlag }, ["unite"], {
        from: a,
        to: b,
      })
    : null;
  const cell = (v: number | null) => (v === null ? "—" : v.toLocaleString());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Doctor activity"
        description="Invoices, patients and revenue by doctor. These are activity measures, not a judgement of clinical quality."
      />
      <Alert>
        <AlertTitle>Which doctor is counted</AlertTitle>
        <AlertDescription>{doctorBasisNote(settings.doctorBasis)}</AlertDescription>
      </Alert>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">From</span>
          <Input name="from" type="date" defaultValue={a} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">To</span>
          <Input name="to" type="date" defaultValue={b} />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>

      {prov && (
        <ProvenanceStrip
          p={prov}
          exceptionsHref={canSee("finance.exceptions.manage") ? "/finance/exceptions" : undefined}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>By doctor</CardTitle>
          <CardDescription>
            Revenue is invoice net (deleted invoices excluded). Patients are counted once per
            doctor. New and returning appear only when the range starts after the first invoice on
            record
            {historyFrom ? ` (${historyFrom})` : ""}, because before that every patient would look
            new.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No invoices with a doctor in this range yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Doctor</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead className="text-right">Invoices</TableHead>
                    <TableHead className="text-right">Patients</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Returning</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Per patient</TableHead>
                    <TableHead className="text-right">Completed appts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.doctor_dha_id}>
                      <TableCell className="text-sm">
                        {r.doctor_name ?? r.doctor_dha_id}
                        {r.doctor_name && (
                          <span className="text-muted-foreground block font-mono text-[10px]">
                            {r.doctor_dha_id}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{r.department ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.invoices.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.patients.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cell(r.new_patients)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cell(r.returning_patients)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.revenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.patients > 0 ? money(r.revenue / r.patients) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cell(r.completed_appointments)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertTitle>Known limits</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-5">
            <li>
              Completed appointments are matched when the doctor&apos;s Unite id equals the DHA id
              on the invoice; a dash means no match, not zero.
            </li>
            <li>
              Free appointment slots are not worked hours. Clinical-hour productivity needs the rota
              and is not shown.
            </li>
            <li>
              Comparing doctors needs specialty, case mix and patient decisions taken into account,
              with the Medical Director&apos;s review. Contribution once costs are approved is on
              the Profitability page.
            </li>
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );
}
