import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
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
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { loadBlueprintSettings } from "@/lib/finance/blueprint-settings";
import { loadFollowupSettings } from "@/lib/finance/followup-settings";
import { money } from "@/lib/finance/format";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createClient } from "@/lib/supabase/server";

import {
  BlueprintSettingsForm,
  ChangeReviewSettingsForm,
  CodeForm,
  FollowupSettingsForm,
  PriceImport,
  RemoveCode,
  RemovePrice,
  ThresholdsForm,
  type CodeRow,
} from "./forms";

export const metadata = { title: "Workflow settings" };
export const dynamic = "force-dynamic";

const PAGE = 100;

export default async function WorkflowSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ payer?: string }>;
}) {
  const member = await requirePerm("finance.reference.manage");
  const sp = await searchParams;
  const supabase = await createClient();
  const settings = await loadFinanceSettings(supabase, member.orgId);
  const blueprint = await loadBlueprintSettings(supabase, member.orgId);
  const followup = await loadFollowupSettings(supabase, member.orgId);
  const payerFilter = (sp.payer ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  let priceQuery = supabase
    .from("fin_ref_payer_prices")
    .select("id, payer_id, cpt_code, agreed_price, effective_from, effective_to", {
      count: "exact",
    })
    .order("payer_id")
    .order("cpt_code")
    .order("effective_from", { ascending: false })
    .limit(PAGE);
  if (payerFilter) priceQuery = priceQuery.eq("payer_id", payerFilter);
  const [{ data: codes }, { data: prices, count }, { data: roles }, { data: changeRow }] =
    await Promise.all([
      supabase
        .from("fin_ref_denial_codes")
        .select(
          "code, is_family, description, category, default_owner_role, resubmit_days, appealable, active, is_placeholder",
        )
        .order("code"),
      priceQuery,
      supabase.from("roles").select("name").eq("org_id", member.orgId).order("name"),
      supabase
        .from("fin_ref_finance_settings")
        .select("change_review_start_date, change_review_min_amount, change_bulk_approve_max")
        .eq("org_id", member.orgId)
        .maybeSingle(),
    ]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workflow settings"
        description="The numbers and lists behind pre-authorisations, ready-to-bill, denials, remittance, scorecards, the forecast, the cash-up and invoice-change review. Every rule reads its thresholds from here."
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Thresholds</CardTitle>
          <CardDescription>
            The starting values are placeholders to agree with finance. Switch-on dates are blank,
            so nothing is flagged until you set them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ThresholdsForm s={settings} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Doctor basis, accepted claims, evidence checks and escalation
          </CardTitle>
          <CardDescription>
            Decisions from the integration blueprint. Each one fails closed: nothing is flagged,
            counted as accepted or attributed to a doctor until it is set here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BlueprintSettingsForm s={blueprint} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Insurance follow-up and ageing</CardTitle>
          <CardDescription>
            Unpaid claims are followed up at each stage (by default 60, 90 and 120 days after the
            transaction date). Tasks are off until you set a start date, so switching on never
            floods old claims. The 0-30 / 31-60 / 61-90 / 90+ ageing of the monthly summary and of
            closed month packs does not change.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FollowupSettingsForm s={followup} roles={(roles ?? []).map((r) => r.name)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice-change review</CardTitle>
          <CardDescription>
            Who may discount, cancel, refund or credit a Unite invoice, and up to what amount, is
            not agreed yet, so by default every change needs an approval in Invoice changes. The
            unapproved-changes measure counts from the date set here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeReviewSettingsForm
            s={{
              startDate: changeRow?.change_review_start_date ?? null,
              minAmount: Number(changeRow?.change_review_min_amount ?? 0),
              bulkMax: Number(changeRow?.change_bulk_approve_max ?? 0),
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Denial reason codes</CardTitle>
          <CardDescription>
            An exact code is used first, then a family (the letters before the first dash or digit).
            Rows marked as starter placeholders are examples only: load your payers&apos; real code
            lists here. The days set the resubmission deadline.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CodeForm />
          {((codes ?? []) as CodeRow[]).map((c) => (
            <div key={c.code} className="flex flex-col gap-1">
              <CodeForm row={c} />
              <div>
                <RemoveCode code={c.code} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payer price lists</CardTitle>
          <CardDescription>
            The agreed price per payer and CPT code. A payment advice is checked against it: a payer
            that pays less than the agreed price (or the amount claimed, if lower) is flagged as a
            short payment.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <PriceImport />
          <form className="flex gap-2">
            <Input
              name="payer"
              placeholder="Show one payer"
              defaultValue={payerFilter}
              className="max-w-60"
            />
            <Button type="submit" variant="outline">
              Filter
            </Button>
          </form>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payer</TableHead>
                <TableHead>CPT</TableHead>
                <TableHead className="text-right">Agreed price</TableHead>
                <TableHead>From</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(prices ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-xs">{p.payer_id}</TableCell>
                  <TableCell className="font-mono text-xs">{p.cpt_code}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(p.agreed_price)}
                  </TableCell>
                  <TableCell className="text-xs">{p.effective_from}</TableCell>
                  <TableCell className="text-right">
                    <RemovePrice id={p.id} />
                  </TableCell>
                </TableRow>
              ))}
              {(prices ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <EmptyState title="No prices loaded" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {(count ?? 0) > PAGE && (
            <p className="text-muted-foreground text-xs">
              Showing the first {PAGE} of {count}. Filter by payer to see the rest.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
