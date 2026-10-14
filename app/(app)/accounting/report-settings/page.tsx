import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { ReportSettingsForm, type ReportSettingsView } from "./form";

export const metadata = { title: "Report settings" };
export const dynamic = "force-dynamic";

const DEFAULTS: ReportSettingsView = {
  acc_budget_variance_pct: 10,
  acc_large_journal_amount: 50000,
  acc_ct_rate: 9,
  acc_ct_threshold: 375000,
  acc_ct_entertainment_pct: 50,
  acc_ct_sbr_limit: 3000000,
  acc_ct_connected_limit: 500000,
};

export default async function ReportSettingsPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.settings.manage", "accounting.reports.view"]))
    throw new ForbiddenError("accounting.settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data } = await admin
    .from("fin_ref_finance_settings")
    .select(
      "acc_budget_variance_pct, acc_large_journal_amount, acc_ct_rate, acc_ct_threshold, acc_ct_entertainment_pct, acc_ct_sbr_limit, acc_ct_connected_limit",
    )
    .eq("org_id", member.orgId)
    .maybeSingle();
  const values = Object.fromEntries(
    Object.entries(DEFAULTS).map(([k, v]) => [
      k,
      Number(data?.[k as keyof ReportSettingsView] ?? v),
    ]),
  ) as ReportSettingsView;
  const editable = can(member, "accounting.settings.manage");
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Report settings"
        description="Thresholds used by the accounting reports. Tax figures here feed a working paper only; confirm them with the tax adviser."
      />
      <Card>
        <CardContent className="pt-6">
          <ReportSettingsForm values={values} editable={editable} />
          {!editable && (
            <p className="text-muted-foreground mt-3 text-xs">
              Only someone with the accounting settings permission can change these.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
