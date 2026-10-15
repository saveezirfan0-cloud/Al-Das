import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadFreshness } from "@/lib/finance/freshness";
import { readinessSteps } from "@/lib/finance/readiness";
import { loadClinicSetupFacts } from "@/lib/golive/clinic-setup-server";
import {
  goLiveRows,
  summariseRows,
  type IntegrationFact,
  type ReadinessRow,
  type RowGroup,
} from "@/lib/golive/readiness";
import { INTEGRATIONS } from "@/lib/integrations/catalog";
import { loadIntegrationHealth } from "@/lib/integrations/health-server";
import { readinessProblems } from "@/lib/integrations/readiness";
import { loadReadinessInput } from "@/lib/integrations/readiness-server";
import { getSystemHealth } from "@/lib/jobs/health";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isTrainingOrg } from "@/lib/training/mode";
import { hasCredentials, loadUniteAccount } from "@/lib/unite/store";

export const metadata = { title: "Go-live checklist" };
export const dynamic = "force-dynamic";

const BADGE: Record<
  ReadinessRow["status"],
  { label: string; variant: "success" | "warning" | "destructive" | "outline" | "secondary" }
> = {
  ok: { label: "Ready", variant: "success" },
  warn: { label: "Check", variant: "warning" },
  missing: { label: "Not set up", variant: "outline" },
  blocked: { label: "Waiting", variant: "secondary" },
};

export default async function GoLiveReadinessPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const org = member.orgId;
  const manageIntegrations = can(member, "integrations.manage");

  const [health, integrations, unite, training, setup, templates, freshness] = await Promise.all([
    getSystemHealth(admin),
    loadIntegrationHealth(admin, org),
    loadUniteAccount(admin, org),
    isTrainingOrg(admin, org),
    loadClinicSetupFacts(admin, org, { staff: can(member, "hr.view") }),
    admin
      .from("wa_templates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org)
      .eq("status", "APPROVED")
      .is("archived_at", null),
    // Finance data through the member's own client (RLS): no finance role, no finance facts.
    createClient().then(loadFreshness),
  ]);

  // What is still missing for an integration that is off. Only for people who may manage integrations (the check can open
  // the stored seal certificate); everyone else sees on/off and health.
  const integrationFacts: IntegrationFact[] = await Promise.all(
    integrations.map(async (i) => {
      const def = INTEGRATIONS.find((d) => d.kind === i.kind)!;
      const problems =
        !i.view.enabled && manageIntegrations
          ? readinessProblems(await loadReadinessInput(admin, org, i.kind, i.view))
          : null;
      return {
        kind: i.kind,
        title: i.title,
        enabled: i.view.enabled,
        health: i.state,
        problems,
        viewPermission: def.viewPermission,
      };
    }),
  );

  const rows = goLiveRows({
    // Only yes/no leaves lib/golive/readiness.ts; no value is rendered.
    env: process.env,
    clinic: setup.clinic,
    whatsapp: { ...setup.whatsapp, approvedTemplates: templates.count ?? 0 },
    trainingMode: training,
    unite: {
      credentials: !!unite && hasCredentials(unite.row),
      syncOn: !!unite && Object.values(unite.config.enabled).some(Boolean),
    },
    finance: freshness ? readinessSteps(freshness) : null,
    integrations: integrationFacts,
    cron: { available: health.cronAvailable, jobs: health.cron },
    deadLetters: health.deadLetters.length,
  });
  const summary = summariseRows(rows);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Go-live checklist"
        description="What is set up and what is still missing before patients are moved to Pulse. Each item links to where it is fixed. Before moving a WhatsApp number, also run the cut-over preflight (pnpm cutover:preflight)."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Summary
          label="Required"
          value={`${summary.requiredReady} of ${summary.requiredTotal}`}
          hint="ready"
          good={summary.requiredReady === summary.requiredTotal}
        />
        <Summary
          label="Needs attention"
          value={String(summary.attention)}
          hint={summary.attention ? "items to check" : "nothing to check"}
          good={summary.attention === 0}
        />
        <Summary
          label="Optional"
          value={`${summary.optionalReady} of ${summary.optionalTotal}`}
          hint="switched on"
        />
      </div>

      {(["Required", "Optional"] as const).map((group) => (
        <RowGroupCard
          key={group}
          group={group}
          rows={rows.filter((r) => r.group === group)}
          allowed={(perm) => !perm || can(member, perm)}
        />
      ))}
    </div>
  );
}

function RowGroupCard({
  group,
  rows,
  allowed,
}: {
  group: RowGroup;
  rows: readonly ReadinessRow[];
  allowed: (perm: string | undefined) => boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{group}</CardTitle>
        <CardDescription>
          {group === "Required"
            ? "Pulse should not take over patient messaging until these are ready."
            : "Features you can switch on when you need them."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-border flex flex-col divide-y">
          {rows.map((r) => {
            const badge =
              r.status === "missing" && r.group === "Required"
                ? { label: "Missing", variant: "destructive" as const }
                : BADGE[r.status];
            return (
              <li
                key={r.key}
                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4"
              >
                <div className="sm:w-28 sm:shrink-0">
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {r.href && allowed(r.perm) ? (
                      <Link href={r.href} className="underline-offset-2 hover:underline">
                        {r.label}
                      </Link>
                    ) : (
                      r.label
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs text-pretty break-words">
                    {r.detail}
                  </p>
                  {r.href === null && (
                    <p className="text-muted-foreground text-xs">
                      Where: the hosting environment (Vercel project settings), then redeploy.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Summary({
  label,
  value,
  hint,
  good,
}: {
  label: string;
  value: string;
  hint: string;
  good?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-3xl tabular-nums ${good === true ? "text-emerald-700 dark:text-emerald-400" : ""}`}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">{hint}</CardContent>
    </Card>
  );
}
