import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const admin = can(member, "settings.manage");
  const contacts = can(member, "contacts.manage");
  const items = [
    { href: "/settings/account", label: "Account" },
    ...(admin
      ? [
          { href: "/settings/users", label: "Users" },
          { href: "/settings/roles", label: "Roles" },
          { href: "/settings/teams", label: "Teams" },
          { href: "/settings/custom-fields", label: "Custom fields" },
          { href: "/settings/channels", label: "Channels" },
          { href: "/settings/inbox", label: "Inbox" },
          { href: "/settings/appointments", label: "Appointments" },
        ]
      : []),
    ...(contacts ? [{ href: "/settings/tags", label: "Tags" }] : []),
    ...(admin ? [{ href: "/settings/system-health", label: "System health" }] : []),
  ];
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SettingsNav items={items} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
