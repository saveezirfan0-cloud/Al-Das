import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { parseRule, ruleSummary, type SchemeStatus } from "@/lib/finance/revshare";
import { knownCategories, profileNames } from "@/lib/finance/revshare-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { SchemeSheet, SchemeStepButton } from "../controls";
import { RevshareTabs, VIEW_PERMS } from "../tabs";

export const metadata = { title: "Revenue share schemes" };
export const dynamic = "force-dynamic";

const STATUS: Record<
  SchemeStatus,
  { label: string; variant: "outline" | "secondary" | "success" | "warning" }
> = {
  draft: { label: "Draft", variant: "outline" },
  verified: { label: "Verified, waiting for the CEO", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  retired: { label: "Retired", variant: "secondary" },
};

export default async function RevshareSchemesPage() {
  const member = await requireMember();
  if (!canAny(member, VIEW_PERMS)) redirect("/finance");
  const canManage = can(member, "finance.revshare.manage");
  const canVerify = can(member, "finance.revshare.verify");
  const canApprove = can(member, "finance.revshare.approve");

  // The member's own client: row level security decides what is returned.
  const supabase = await createClient();
  const { data: schemes } = await supabase
    .from("fin_revshare_schemes")
    .select("*")
    .order("doctor_dha_id")
    .order("version", { ascending: false })
    .limit(1000);
  const admin = createAdminClient(); // service role AFTER the permission check (names and categories only)
  const [categories, name, doctors] = await Promise.all([
    canManage ? knownCategories(admin, member.orgId) : Promise.resolve([] as string[]),
    profileNames(
      admin,
      (schemes ?? []).flatMap((s) => [s.verified_by, s.approved_by, s.retired_by]),
    ),
    supabase.from("fin_ref_doctors").select("dha_id, name").limit(2000),
  ]);
  const doctorName = new Map(
    (doctors.data ?? []).map((d) => [d.dha_id.trim().toUpperCase(), d.name]),
  );
  const byDoctor = new Map<string, NonNullable<typeof schemes>>();
  for (const s of schemes ?? [])
    byDoctor.set(s.doctor_dha_id, [...(byDoctor.get(s.doctor_dha_id) ?? []), s]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Revenue share schemes"
        description="One approved rule per doctor contract, versioned. A version is drafted by Finance, verified by Finance and approved by the CEO (two different people, bound to the rule's fingerprint); an approved version never changes."
      >
        {canManage && <SchemeSheet trigger="New scheme" categories={categories} />}
      </PageHeader>
      <RevshareTabs active="schemes" />

      <Alert>
        <AlertTitle>How a rule works</AlertTitle>
        <AlertDescription className="text-xs">
          Payout = the larger of the minimum guarantee and (share of each service category&apos;s
          net revenue, only on revenue above the threshold, less the share of the doctor&apos;s
          charges deducted), never below zero. A run uses the newest approved version whose start
          month has begun; a retired version means no scheme from its start month.
        </AlertDescription>
      </Alert>

      {byDoctor.size === 0 && (
        <p className="text-muted-foreground text-sm">
          No schemes yet. Add one per doctor contract.
        </p>
      )}

      {[...byDoctor.entries()].map(([doctor, versions]) => {
        const open = versions.find((v) => v.status === "draft" || v.status === "verified");
        return (
          <Card key={doctor}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {doctorName.get(doctor) ?? doctor}
                <span className="text-muted-foreground text-xs font-normal">{doctor}</span>
              </CardTitle>
              {canManage && !open && (
                <CardDescription>
                  <SchemeSheet trigger="New version" categories={categories} doctor={doctor} />
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => {
                    const rule = parseRule(v.rule);
                    const st = STATUS[v.status as SchemeStatus];
                    return (
                      <TableRow key={v.id}>
                        <TableCell className="align-top text-xs">{v.version}</TableCell>
                        <TableCell className="align-top text-xs">
                          {v.effective_from.slice(0, 7)}
                        </TableCell>
                        <TableCell className="max-w-md align-top text-xs whitespace-normal">
                          {rule ? ruleSummary(rule) : "—"}
                          <div className="text-muted-foreground">
                            Fingerprint{" "}
                            <span className="font-mono">{v.rule_hash.slice(0, 12)}</span>
                            {v.note ? ` · ${v.note}` : ""}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-xs">
                          <Badge variant={st.variant}>{st.label}</Badge>
                          {v.verified_at && (
                            <div className="text-muted-foreground mt-1">
                              Verified: {name(v.verified_by)}
                            </div>
                          )}
                          {v.approved_at && (
                            <div className="text-muted-foreground">
                              Approved: {name(v.approved_by)}
                            </div>
                          )}
                          {v.retired_at && (
                            <div className="text-muted-foreground">
                              Retired: {name(v.retired_by)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-wrap justify-end gap-2">
                            {canManage &&
                              rule &&
                              (v.status === "draft" || v.status === "verified") && (
                                <SchemeSheet
                                  trigger="Edit"
                                  categories={categories}
                                  scheme={{
                                    id: v.id,
                                    doctor: v.doctor_dha_id,
                                    effectiveFrom: v.effective_from,
                                    rule,
                                    note: v.note,
                                  }}
                                />
                              )}
                            {canVerify && v.status === "draft" && (
                              <SchemeStepButton id={v.id} hash={v.rule_hash} step="verify" />
                            )}
                            {canApprove &&
                              v.status === "verified" &&
                              v.verified_by !== member.userId && (
                                <SchemeStepButton id={v.id} hash={v.rule_hash} step="approve" />
                              )}
                            {canApprove &&
                              v.status === "verified" &&
                              v.verified_by === member.userId && (
                                <span className="text-muted-foreground text-xs">
                                  You verified it; someone else approves.
                                </span>
                              )}
                            {canApprove && v.status === "approved" && (
                              <SchemeStepButton id={v.id} hash={v.rule_hash} step="retire" />
                            )}
                            {canManage && (v.status === "draft" || v.status === "verified") && (
                              <SchemeStepButton id={v.id} hash={v.rule_hash} step="delete" />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
