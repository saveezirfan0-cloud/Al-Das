import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { inviteState } from "@/lib/invites/token";
import { createAdminClient } from "@/lib/supabase/admin";

import { InviteDialog } from "./invite-dialog";
import { InvitesTable } from "./invites-table";
import { MembersTable } from "./members-table";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();

  const [
    { data: memberships },
    { data: roles },
    { data: teams },
    { data: invites },
    { data: teamMembers },
  ] = await Promise.all([
    admin
      .from("memberships")
      .select(
        "id, user_id, status, presence, presence_at, created_at, role_id, roles(name), profiles:profiles!memberships_user_id_fkey(first_name, last_name, email, designation)",
      )
      .eq("org_id", member.orgId)
      .order("created_at"),
    admin.from("roles").select("id, name, is_system").eq("org_id", member.orgId).order("name"),
    admin.from("teams").select("id, name").eq("org_id", member.orgId).order("name"),
    admin
      .from("invites")
      .select("id, email, expires_at, accepted_at, revoked_at, created_at, roles(name)")
      .eq("org_id", member.orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
    admin.from("team_members").select("user_id, teams(name)").eq("org_id", member.orgId),
  ]);

  const teamsByUser = new Map<string, string[]>();
  for (const tm of teamMembers ?? []) {
    const list = teamsByUser.get(tm.user_id) ?? [];
    if (tm.teams?.name) list.push(tm.teams.name);
    teamsByUser.set(tm.user_id, list);
  }

  const rows = (memberships ?? []).map((m) => ({
    id: m.id,
    userId: m.user_id,
    name: `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim(),
    email: m.profiles?.email ?? "",
    designation: m.profiles?.designation ?? null,
    roleId: m.role_id,
    roleName: m.roles?.name ?? "",
    status: m.status as "active" | "suspended",
    presence: m.presence as "online" | "away" | "offline",
    teams: teamsByUser.get(m.user_id) ?? [],
    isSelf: m.id === member.membershipId,
  }));

  const pending = (invites ?? []).map((i) => ({
    id: i.id,
    email: i.email,
    roleName: i.roles?.name ?? "",
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    state: inviteState(i),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Users" description="Who can sign in, with which role, and in which teams.">
        <InviteDialog roles={roles ?? []} teams={teams ?? []} />
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {rows.length} account{rows.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MembersTable rows={rows} roles={roles ?? []} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
          <CardDescription>Links expire after 7 days. Resending rotates the link.</CardDescription>
        </CardHeader>
        <CardContent>
          <InvitesTable rows={pending} />
        </CardContent>
      </Card>
    </div>
  );
}
