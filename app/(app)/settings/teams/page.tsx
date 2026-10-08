import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { TeamActions } from "./team-actions";
import { TeamDialog } from "./team-dialog";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [{ data: teams }, { data: members }, { data: teamMembers }] = await Promise.all([
    admin
      .from("teams")
      .select("id, name, description, round_robin")
      .eq("org_id", member.orgId)
      .order("name"),
    admin
      .from("memberships")
      .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
      .eq("org_id", member.orgId)
      .eq("status", "active"),
    admin.from("team_members").select("team_id, user_id").eq("org_id", member.orgId),
  ]);

  const people = (members ?? []).map((m) => ({
    id: m.user_id,
    label:
      `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
      m.profiles?.email ||
      m.user_id,
  }));
  const byTeam = new Map<string, string[]>();
  for (const tm of teamMembers ?? [])
    byTeam.set(tm.team_id, [...(byTeam.get(tm.team_id) ?? []), tm.user_id]);
  const nameOf = new Map(people.map((p) => [p.id, p.label]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Teams"
        description="Inbox queues and assignment groups. Round-robin shares new conversations across members."
      >
        <TeamDialog mode="create" people={people} />
      </PageHeader>
      {(teams ?? []).length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No teams yet. Create one to start routing conversations.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(teams ?? []).map((t) => {
            const ids = byTeam.get(t.id) ?? [];
            return (
              <Card key={t.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {t.name}
                    {t.round_robin && <Badge variant="outline">Round-robin</Badge>}
                  </CardTitle>
                  <CardDescription>{t.description || "No description"}</CardDescription>
                  <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
                    <TeamActions
                      team={{
                        id: t.id,
                        name: t.name,
                        description: t.description ?? "",
                        round_robin: t.round_robin,
                        member_ids: ids,
                      }}
                      people={people}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-muted-foreground mb-2 text-xs">
                    {ids.length} member{ids.length === 1 ? "" : "s"}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {ids.map((id) => (
                      <Badge key={id} variant="secondary">
                        {nameOf.get(id) ?? "Unknown"}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
