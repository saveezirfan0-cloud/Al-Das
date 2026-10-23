import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { parseBranchScope } from "@/lib/branches/access";
import { parseEnquiryScope } from "@/lib/enquiries/scope";
import { inviteState } from "@/lib/invites/token";
import { cleanMenuHidden, menuChoicesFor, readOrgMenuHidden } from "@/lib/nav/menu-visibility";
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
    { data: locations },
  ] = await Promise.all([
    admin
      .from("memberships")
      .select(
        "id, user_id, status, presence, presence_at, created_at, role_id, max_open_conversations, enquiry_scope, branch_scope, home_location_id, menu_hidden, membership_locations(location_id), roles(name), profiles:profiles!memberships_user_id_fkey(first_name, last_name, email, designation)",
      )
      .eq("org_id", member.orgId)
      .order("created_at"),
    admin
      .from("roles")
      .select("id, name, is_system, permissions")
      .eq("org_id", member.orgId)
      .order("name"),
    admin.from("teams").select("id, name").eq("org_id", member.orgId).order("name"),
    admin
      .from("invites")
      .select("id, email, expires_at, accepted_at, revoked_at, created_at, roles(name)")
      .eq("org_id", member.orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
    admin.from("team_members").select("user_id, teams(name)").eq("org_id", member.orgId),
    admin
      .from("locations")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
  ]);

  // Per role, the menu entries it can see at all: what the invite and Menu access dialogs offer.
  const roleOptions = (roles ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    menu: menuChoicesFor({
      userId: "",
      orgId: member.orgId,
      roleId: r.id,
      roleName: r.name,
      status: "active",
      permissions: Array.isArray(r.permissions)
        ? (r.permissions as unknown[]).filter((p): p is string => typeof p === "string")
        : [],
    }),
  }));
  const workspaceHidden = readOrgMenuHidden(member.org.settings);

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
    maxOpen: m.max_open_conversations,
    enquiryScope: parseEnquiryScope(m.enquiry_scope),
    branchScope: parseBranchScope(m.branch_scope),
    branchIds: (m.membership_locations ?? []).map((l) => l.location_id),
    homeLocationId: m.home_location_id,
    menuHidden: cleanMenuHidden(m.menu_hidden),
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
      <PageHeader
        title="Users"
        description="Who can sign in, with which role, in which teams and branches, and what their menu shows."
      >
        <InviteDialog roles={roleOptions} teams={teams ?? []} workspaceHidden={workspaceHidden} />
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {rows.length} account{rows.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MembersTable
            rows={rows}
            roles={roleOptions}
            locations={locations ?? []}
            workspaceHidden={workspaceHidden}
          />
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
