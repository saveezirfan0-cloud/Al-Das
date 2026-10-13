import { redirect } from "next/navigation";

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
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { monthLabel } from "@/lib/finance/close-pack";
import { lastClosedMonth } from "@/lib/finance/close-server";
import { money } from "@/lib/finance/format";
import { CHARGE_KIND_LABELS, CHARGE_KINDS, type ChargeKind } from "@/lib/finance/revshare";
import { MONTH_RE } from "@/lib/finance/revshare-server";
import { createClient } from "@/lib/supabase/server";

import { ChargeSheet, ChargesUpload, DeleteChargeButton } from "../controls";
import { RevshareTabs, VIEW_PERMS } from "../tabs";

export const metadata = { title: "Doctor charges" };
export const dynamic = "force-dynamic";

const SOURCE: Record<string, string> = {
  manual: "Typed in",
  upload: "Upload",
  lab_recon: "Lab reconciliation",
  referral_recon: "Referral reconciliation",
};

export default async function DoctorChargesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VIEW_PERMS)) redirect("/finance");
  const canManage = can(member, "finance.revshare.manage");
  const sp = await searchParams;
  const month =
    sp.month && MONTH_RE.test(sp.month) ? sp.month : lastClosedMonth(todayIn(member.org.timezone));

  // The member's own client: row level security decides what is returned.
  const supabase = await createClient();
  const [{ data: charges }, { data: run }] = await Promise.all([
    supabase
      .from("fin_doctor_charges")
      .select("id, doctor_dha_id, kind, amount, source, reference, note, created_at")
      .eq("month", `${month}-01`)
      .order("doctor_dha_id")
      .order("kind")
      .order("created_at")
      .limit(5000),
    supabase.from("fin_revshare_runs").select("status").eq("month", `${month}-01`).maybeSingle(),
  ]);
  const frozen = !!run && run.status !== "draft";

  const totals = new Map<string, Record<ChargeKind, number>>();
  for (const c of charges ?? []) {
    const t = totals.get(c.doctor_dha_id) ?? { lab: 0, referral: 0, consumables: 0, other: 0 };
    t[c.kind as ChargeKind] += Number(c.amount);
    totals.set(c.doctor_dha_id, t);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Doctor charges"
        description="Lab, external referral, consumable and other costs charged to a doctor's account before the revenue share is finalised (by working day 7). Each scheme says what share of each kind is deducted."
      >
        {canManage && !frozen && <ChargeSheet month={month} />}
      </PageHeader>
      <RevshareTabs active="charges" />

      <form className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Month</span>
          <Input name="month" type="month" defaultValue={month} />
        </label>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>

      {frozen && (
        <Alert>
          <AlertTitle>Frozen</AlertTitle>
          <AlertDescription>
            The revenue share of {monthLabel(`${month}-01`)} is verified, so its charges cannot
            change. Finance can return the run to draft before the CEO approves it.
          </AlertDescription>
        </Alert>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload a CSV</CardTitle>
            <CardDescription>
              Columns: month (2026-09), doctor_dha_id, kind ({CHARGE_KINDS.join(", ")}), amount, and
              optionally reference and note. A file is saved whole or not at all. It replaces the
              uploaded charges of the same month and kind, so a corrected file can be uploaded
              again; charges typed in here are kept. No patient names.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChargesUpload />
          </CardContent>
        </Card>
      )}

      {totals.size > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Totals for {monthLabel(`${month}-01`)}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Doctor</TableHead>
                  {CHARGE_KINDS.map((k) => (
                    <TableHead key={k} className="text-right">
                      {CHARGE_KIND_LABELS[k]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...totals.entries()].map(([d, t]) => (
                  <TableRow key={d}>
                    <TableCell className="text-xs">{d}</TableCell>
                    {CHARGE_KINDS.map((k) => (
                      <TableCell key={k} className="text-right text-xs tabular-nums">
                        {t[k] ? money(t[k]) : "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Charges</CardTitle>
        </CardHeader>
        <CardContent>
          {(charges ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No charges for this month.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Doctor</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(charges ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-xs">{c.doctor_dha_id}</TableCell>
                    <TableCell className="text-xs">
                      {CHARGE_KIND_LABELS[c.kind as ChargeKind] ?? c.kind}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(c.amount)}
                    </TableCell>
                    <TableCell className="text-xs">{SOURCE[c.source] ?? c.source}</TableCell>
                    <TableCell className="text-xs">{c.reference ?? ""}</TableCell>
                    <TableCell className="max-w-xs text-xs whitespace-normal">
                      {c.note ?? ""}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && !frozen && <DeleteChargeButton id={c.id} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
