import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

import { DashboardTabs } from "./dashboard-tabs";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const tabs = [
    { href: "/dashboard", label: "Overview", exact: true },
    ...(can(member, "reports.view") ? [{ href: "/dashboard/management", label: "Management" }] : []),
    ...(can(member, "reports.view") || can(member, "inbox.view_all") ? [{ href: "/dashboard/team", label: "Team lead" }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      {tabs.length > 1 && <DashboardTabs tabs={tabs} />}
      {children}
    </div>
  );
}
