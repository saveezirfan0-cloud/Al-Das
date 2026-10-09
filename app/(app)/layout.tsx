import { cookies } from "next/headers";

import { NAV_ITEMS, SIDEBAR_COOKIE } from "@/components/shell/nav";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { can, canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const cookieStore = await cookies();
  const collapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "1";

  const items = NAV_ITEMS.filter(
    (i) =>
      (!i.permission || can(member, i.permission)) &&
      (!i.anyPermission || canAny(member, i.anyPermission)),
  );

  const supabase = await createClient();
  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, type, title, body, read_at, created_at")
    .eq("org_id", member.orgId)
    .order("created_at", { ascending: false })
    .limit(20);

  const name = `${member.profile.first_name} ${member.profile.last_name}`.trim();

  return (
    <TooltipProvider>
      <div className="flex h-svh overflow-hidden">
        <Sidebar
          items={items}
          orgName={member.org.name}
          defaultCollapsed={collapsed}
          className="hidden md:flex"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            items={items}
            orgName={member.org.name}
            notifications={notifications ?? []}
            user={{
              userId: member.userId,
              orgId: member.orgId,
              name,
              email: member.user.email ?? "",
              roleName: member.roleName,
              presence: member.presence,
              orgs: member.orgs,
            }}
          />
          <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
