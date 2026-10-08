import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { RoleDialog } from "./role-dialog";
import { RoleActions } from "./role-actions";

export const metadata = { title: "Roles" };

export default async function RolesPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [{ data: roles }, { data: memberships }] = await Promise.all([
    admin
      .from("roles")
      .select("id, name, description, permissions, is_system")
      .eq("org_id", member.orgId)
      .order("is_system", { ascending: false })
      .order("name"),
    admin.from("memberships").select("role_id").eq("org_id", member.orgId),
  ]);
  const counts = new Map<string, number>();
  for (const m of memberships ?? []) counts.set(m.role_id, (counts.get(m.role_id) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Roles"
        description="What each role can see and do. System roles can be adjusted but not renamed or deleted."
      >
        <RoleDialog mode="create" />
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-2">
        {(roles ?? []).map((r) => {
          const perms = (r.permissions as string[]) ?? [];
          const full = perms.includes("*");
          return (
            <Card key={r.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {r.name}
                  {r.is_system && <Badge variant="outline">System</Badge>}
                </CardTitle>
                <CardDescription>{r.description || "No description"}</CardDescription>
                <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
                  <RoleActions
                    role={{
                      id: r.id,
                      name: r.name,
                      description: r.description ?? "",
                      permissions: perms,
                      is_system: r.is_system,
                    }}
                    memberCount={counts.get(r.id) ?? 0}
                  />
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="text-muted-foreground text-xs">
                  {counts.get(r.id) ?? 0} member{(counts.get(r.id) ?? 0) === 1 ? "" : "s"} ·{" "}
                  {full
                    ? "full access"
                    : `${perms.length} permission${perms.length === 1 ? "" : "s"}`}
                </div>
                <div className="flex flex-wrap gap-1">
                  {full ? (
                    <Badge>Everything</Badge>
                  ) : (
                    perms.slice(0, 8).map((p) => (
                      <Badge key={p} variant="secondary">
                        {p}
                      </Badge>
                    ))
                  )}
                  {!full && perms.length > 8 && (
                    <Badge variant="outline">+{perms.length - 8} more</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
