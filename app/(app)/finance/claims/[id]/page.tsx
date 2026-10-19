import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { recordAccess } from "@/lib/security/access-log";
import { Term } from "@/components/shell/term";
import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_VARIANT,
  type ClaimStatus,
} from "@/lib/finance/claim-status";
import { claimStatusesFor, loadClaimStatusSettings } from "@/lib/finance/claim-status-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Claim" };
export const dynamic = "force-dynamic";

const fmt = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "number"
      ? v.toLocaleString()
      : String(v);

const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    "Claim",
    [
      ["claim_status", "Claim status"],
      ["payment_status", "Payment status"],
      ["receipt_status", "Receipt status"],
      ["payer_id", "Payer"],
      ["receiver_id", "Receiver"],
      ["prior_auth_id", "Prior authorisation"],
      ["payment_reference", "Payment reference"],
      ["claim_year", "Year"],
      ["claim_month", "Month"],
    ],
  ],
  [
    "Service",
    [
      ["transaction_date", "Transaction date"],
      ["activity_start_date", "Activity start"],
      ["encounter_type", "Encounter"],
      ["cpt_code", "Code"],
      ["cpt_category", "Category"],
      ["cpt_type", "Type"],
      ["quantity", "Quantity"],
      ["clinician_id", "Clinician"],
      ["ordering_clinician_id", "Ordering clinician"],
    ],
  ],
  [
    "Amounts",
    [
      ["initial_net", "Initial net"],
      ["net", "Net"],
      ["remitted", "Remitted"],
      ["last_remitted", "Last remitted"],
      ["initial_rejected", "Initial rejected"],
      ["rejected", "Rejected"],
      ["unprocessed", "Unprocessed"],
      ["write_off", "Write-off"],
      ["write_off_status", "Write-off status"],
      ["settled", "Settled"],
    ],
  ],
  [
    "Denial and remittance",
    [
      ["denial_type", "Denial type"],
      ["denial_category", "Denial category"],
      ["last_denial_code", "Last denial code"],
      ["initial_denial_code", "Initial denial code"],
      ["denial_comment", "Denial comment"],
      ["resubmission_count", "Resubmissions"],
      ["last_resubmission_date", "Last resubmission"],
      ["remittance_count", "Remittances"],
      ["first_remittance_date", "First remittance"],
      ["last_remittance_date", "Last remittance"],
    ],
  ],
];

export default async function ClaimDetail({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("finance.claims.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: claim } = await supabase
    .from("ins_claim_activities")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!claim) notFound();
  await recordAccess(createAdminClient(), member, {
    entity: "finance_claim",
    entityId: id,
    action: "view",
  });
  const { data: events } = await supabase
    .from("ins_claim_activity_events")
    .select("id, observed_at, changed_fields")
    .eq("claim_activity_id", id)
    .order("observed_at", { ascending: false });
  const record = claim as unknown as Record<string, unknown>;
  // One status per claim: the take-backs and the denial case come from tables with their own keys, read with the
  // service role after finance.claims.view (amounts and statuses only).
  const admin = createAdminClient();
  const statusSettings = await loadClaimStatusSettings(admin, member);
  const st = (await claimStatusesFor(admin, member, [claim], statusSettings)).get(claim.id);
  const status: ClaimStatus = st?.status ?? "unknown";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Claim ${claim.claim_activity_number}`}
        description={`Invoice ${claim.invoice_no}`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/finance/claims">Back to claims</Link>
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            claim.match_status === "matched"
              ? "success"
              : claim.match_status === "ambiguous"
                ? "warning"
                : "destructive"
          }
        >
          {claim.match_status}
        </Badge>
        {claim.match_reason && claim.match_reason !== "ok" && (
          <Badge variant="outline">{claim.match_reason.replaceAll("_", " ")}</Badge>
        )}
        {claim.clinician_mismatch && (
          <Badge variant="warning">clinician differs from invoice</Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Term k="claim-status">Status</Term>
          </CardTitle>
          <CardDescription>
            Worked out from the Diligence figures, payments taken back on payment advices and the
            denial case. Diligence stays the source of truth; nothing here changes the claim.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={CLAIM_STATUS_VARIANT[status]}>{CLAIM_STATUS_LABELS[status]}</Badge>
            {st && st.overpaid > 0 && <Badge variant="warning">Overpaid</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <dt className="text-muted-foreground">Still owed</dt>
            <dd className="tabular-nums">{fmt(st?.outstanding ?? null)}</dd>
            <dt className="text-muted-foreground">
              <Term k="taken-back">Taken back</Term>
            </dt>
            <dd className="tabular-nums">{fmt(st?.takenBack ?? 0)}</dd>
            <dt className="text-muted-foreground">Overpaid</dt>
            <dd className="tabular-nums">{fmt(st?.overpaid ?? 0)}</dd>
          </dl>
          {statusSettings.remittedNetsTakebacks === null && (
            <p role="note" className="text-muted-foreground text-xs">
              <Badge variant="warning" className="mr-1">
                Unconfirmed
              </Badge>
              Whether Diligence&apos;s Remitted already deducts payments taken back is not confirmed
              yet; Pulse assumes it does not and deducts them itself.
            </p>
          )}
          {status === "paid" && (
            <p className="text-muted-foreground text-xs">
              Closed needs the bank receipt, which is not yet linked to single claims.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {GROUPS.map(([title, fields]) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {fields.map(([key, label]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="break-words">{fmt(record[key])}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status history</CardTitle>
          <CardDescription>
            Each change seen between Diligence uploads, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(events ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No changes since the claim first appeared.
            </p>
          ) : (
            <ol className="flex flex-col gap-4">
              {(events ?? []).map((e) => (
                <li key={e.id} className="border-l-2 pl-4">
                  <div className="text-muted-foreground text-xs">
                    {new Date(e.observed_at).toLocaleString()}
                  </div>
                  <ul className="mt-1 text-sm">
                    {Object.entries(
                      e.changed_fields as Record<string, { old: unknown; new: unknown }>,
                    ).map(([field, ch]) => (
                      <li key={field}>
                        <span className="font-medium">{field.replaceAll("_", " ")}</span>:{" "}
                        {fmt(ch.old)} → {fmt(ch.new)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
