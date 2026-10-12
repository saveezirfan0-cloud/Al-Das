import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { INTEGRATIONS } from "@/lib/integrations/catalog";
import { HEALTH_LABEL, type HealthState } from "@/lib/integrations/health";
import { loadIntegrationHealth } from "@/lib/integrations/health-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const VARIANT: Record<
  HealthState,
  "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  off: "outline",
  idle: "secondary",
  ok: "success",
  degraded: "warning",
  down: "destructive",
};

export default async function IntegrationsHubPage() {
  const member = await requireMember();
  const visible = INTEGRATIONS.filter(
    (i) => can(member, i.viewPermission) || can(member, "integrations.manage"),
  );
  if (visible.length === 0) throw new ForbiddenError("integrations.manage");
  const health = await loadIntegrationHealth(createAdminClient(), member.orgId);
  const byKind = new Map(health.map((h) => [h.kind, h]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        description="Connect Pulse to other services. Every integration is off until an administrator switches it on."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {visible.map((def) => {
          const h = byKind.get(def.kind)!;
          return (
            <Link
              key={def.kind}
              href={`/settings/integrations/${def.kind}`}
              className="focus-visible:ring-ring rounded-xl outline-none focus-visible:ring-2"
            >
              <Card className="hover:bg-muted/40 h-full transition-colors">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {def.title}
                    <Badge variant={VARIANT[h.state]}>{HEALTH_LABEL[h.state]}</Badge>
                    {def.contactsPatients && <Badge variant="outline">Messages patients</Badge>}
                    {def.movesMoney && <Badge variant="outline">Takes payments</Badge>}
                  </CardTitle>
                  <CardDescription>{def.description}</CardDescription>
                </CardHeader>
                <CardContent className="text-muted-foreground text-xs">
                  {h.view.lastError
                    ? `Last problem: ${h.view.lastError}`
                    : h.view.lastOkAt
                      ? `Last success ${new Date(h.view.lastOkAt).toLocaleString()}`
                      : "Not used yet"}
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {can(member, "settings.manage") && (
          <Link
            href="/settings/unite"
            className="focus-visible:ring-ring rounded-xl outline-none focus-visible:ring-2"
          >
            <Card className="hover:bg-muted/40 h-full transition-colors">
              <CardHeader>
                <CardTitle className="text-base">Unite EMR</CardTitle>
                <CardDescription>
                  Read-only sync of appointments and patients. Managed on its own page with its own
                  switches.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}
      </div>
    </div>
  );
}
