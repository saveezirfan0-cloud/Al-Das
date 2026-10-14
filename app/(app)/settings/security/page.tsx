import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { formatIp } from "@/lib/security/client-ip";
import {
  DEFAULT_FINANCE_ACCESS,
  holdsRestrictedArea,
  readFinanceAccess,
} from "@/lib/security/finance-access";
import { isSensitiveRole } from "@/lib/security/mfa";
import { readSecuritySettings } from "@/lib/security/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { FinanceWindowForm } from "./finance-window-form";
import { MfaRoleTable, SecuritySettingsForm } from "./security-forms";

export const metadata = { title: "Security" };
export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage() {
  const member = await requirePerm("security.manage");
  const admin = createAdminClient();
  const [{ data: roles }, { data: memberships }] = await Promise.all([
    admin
      .from("roles")
      .select("id, name, permissions, require_mfa")
      .eq("org_id", member.orgId)
      .order("name"),
    admin.from("memberships").select("role_id").eq("org_id", member.orgId).eq("status", "active"),
  ]);
  const counts = new Map<string, number>();
  for (const m of memberships ?? []) counts.set(m.role_id, (counts.get(m.role_id) ?? 0) + 1);
  const rows = (roles ?? []).map((r) => {
    const perms = Array.isArray(r.permissions)
      ? (r.permissions as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    return {
      id: r.id,
      name: r.name,
      required: r.require_mfa,
      sensitive: isSensitiveRole(perms),
      members: counts.get(r.id) ?? 0,
    };
  });
  const exposed = rows.filter((r) => r.sensitive && !r.required);
  const financeWindow = readFinanceAccess(member.org.settings);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Security"
        description="Two-step verification by role, how long access records are kept, when to raise an alert, and when finance can be reached."
      />
      <Card>
        <CardHeader>
          <CardTitle>Two-step verification</CardTitle>
          <CardDescription>
            Members of a role with this switched on must set up an authenticator app before they can
            use anything else. Anyone who has set one up is asked for a code at every sign-in,
            whatever their role says.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {exposed.length > 0 && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              Roles that can change settings, see finance or open clinical records are flagged
              below. Roles without the switch: <b>{exposed.map((r) => r.name).join(", ")}</b>.
            </p>
          )}
          <MfaRoleTable rows={rows} />
          <p className="text-muted-foreground text-xs">
            <Badge variant="outline">Sensitive</Badge> means the role holds settings, security or
            privacy management, any finance permission, or clinical portal access. Turn it on for
            your own role last: you will be asked to set up your app straight away.
          </p>
        </CardContent>
      </Card>
      <SecuritySettingsForm
        initial={readSecuritySettings(member.org.settings)}
        timezone={member.org.timezone}
      />
      <FinanceWindowForm
        initial={financeWindow.ok ? financeWindow.settings : DEFAULT_FINANCE_ACCESS}
        unreadable={!financeWindow.ok}
        roles={(roles ?? []).map((r) => {
          const perms = Array.isArray(r.permissions)
            ? (r.permissions as unknown[]).filter((p): p is string => typeof p === "string")
            : [];
          return {
            id: r.id,
            name: r.name,
            finance: holdsRestrictedArea(perms),
            admin: perms.includes("*"),
          };
        })}
        timezone={member.org.timezone}
        currentIp={member.clientIp ? formatIp(member.clientIp) : null}
      />
    </div>
  );
}
