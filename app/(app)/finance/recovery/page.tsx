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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recoveryBlockers } from "@/lib/finance/recovery-server";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { renderTemplatePreview, templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import {
  ApproveButton,
  EnableForm,
  PreviewPanel,
  SettingsForm,
  type TemplateChoice,
} from "./recovery-controls";

export const metadata = { title: "Self-pay reminders" };
export const dynamic = "force-dynamic";

export default async function RecoveryPage() {
  const member = await requirePerm("finance.recovery.manage");
  const admin = createAdminClient(); // service role AFTER the permission check (templates are not otherwise readable by finance roles)
  const settings = await loadFinanceSettings(admin, member.orgId);
  const { problems, template } = await recoveryBlockers(admin, member.orgId, settings);
  const { data: tpls } = await admin
    .from("wa_templates")
    .select("id, name, language, components")
    .eq("org_id", member.orgId)
    .eq("status", "APPROVED")
    .is("archived_at", null)
    .order("name")
    .limit(200);
  const templates: TemplateChoice[] = (tpls ?? []).map((t) => {
    const comps = (t.components ?? []) as unknown as MetaTemplateComponent[];
    return {
      id: t.id,
      name: t.name,
      language: t.language,
      variables: templateVariables(comps)
        .filter((v) => v.kind === "text" && v.component !== "button")
        .map((v) => v.key),
      wording: [
        renderTemplatePreview(comps, {}).headerText,
        renderTemplatePreview(comps, {}).body,
        renderTemplatePreview(comps, {}).footer,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
  const supabase = await createClient();
  const { data: recent } = await supabase
    .from("fin_recovery_reminders")
    .select(
      "id, sequence_no, status, balance, created_at, skip_reason, fin_invoices(inv_display_number)",
    )
    .order("created_at", { ascending: false })
    .limit(40);
  const approved = !!settings.recovery.toneApprovedHash;
  const canApprove = can(member, "finance.recovery.approve");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Self-pay reminders"
        description="Reminders for unpaid self-pay balances, sent on WhatsApp as an approved template, only to patients who opted in and have not stopped messages. Off until Finance has approved the wording."
      />
      <Alert variant={settings.recovery.enabled ? "default" : "destructive"}>
        <AlertTitle>
          {settings.recovery.enabled ? "Reminders are ON" : "Reminders are OFF"}
        </AlertTitle>
        <AlertDescription>
          {problems.length === 0 ? (
            settings.recovery.enabled ? (
              "The daily job sends a batch each morning."
            ) : (
              "Everything needed is in place. Switch them on below when you are ready."
            )
          ) : (
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Template and rules</CardTitle>
          <CardDescription>
            A guardian receives the reminder for a dependant, and the guardian&apos;s own opt-in is
            what counts. A patient with no opt-in, or who stopped marketing, is never messaged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            templates={templates}
            values={{
              templateId: settings.recovery.templateId,
              map: settings.recovery.variableMap,
              minBalance: settings.recovery.minBalance,
              minDaysOverdue: settings.recovery.minDaysOverdue,
              gapDays: settings.recovery.gapDays,
              maxReminders: settings.recovery.maxReminders,
              batchSize: settings.recovery.batchSize,
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Finance reviews the tone</CardTitle>
          <CardDescription>
            {approved
              ? `Approved ${settings.recovery.toneApprovedAt ? new Date(settings.recovery.toneApprovedAt).toLocaleDateString("en-GB") : ""} for the current wording.`
              : "Not approved yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {template ? (
            <p className="bg-muted/40 rounded p-3 text-xs whitespace-pre-wrap">
              {templates.find((t) => t.id === template.id)?.wording ?? "(wording not available)"}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">Choose a template above first.</p>
          )}
          {canApprove ? (
            <div>
              <ApproveButton approved={approved} />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Someone with the “Approve the tone of recovery reminders” permission (Finance) must
              approve the wording.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Switch on</CardTitle>
        </CardHeader>
        <CardContent>
          <EnableForm enabled={settings.recovery.enabled} ready={problems.length === 0} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Next batch</CardTitle>
          <CardDescription>
            Invoice numbers and amounts only; no names or numbers are shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PreviewPanel canRun={settings.recovery.enabled && problems.length === 0} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent reminders</CardTitle>
        </CardHeader>
        <CardContent>
          {(recent ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">None yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead className="text-right">Reminder</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">
                      {new Date(r.created_at).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.fin_invoices?.inv_display_number ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">{r.sequence_no}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {r.balance === null ? "—" : money(r.balance)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "queued" ? "success" : "destructive"}>
                        {r.status === "queued" ? "queued" : (r.skip_reason ?? "failed")}
                      </Badge>
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
