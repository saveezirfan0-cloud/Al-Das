import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import { canReadObject } from "@/lib/portal/permissions";

import { SettingsNav } from "../settings/settings-nav";
import { PORTAL_SECTIONS } from "./sections";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const screens = PORTAL_SECTIONS.filter((s) => can(member, s.read)).map((s) => ({
    href: s.href,
    label: s.label,
  }));
  // Object routes are /portal/<key>; objects an admin switched off still resolve to a 404 in the page.
  const objects = PORTAL_OBJECTS.filter((o) => canReadObject(member, o)).map((o) => ({
    href: `/portal/${o.key}`,
    label: o.label,
  }));
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SettingsNav
        items={[{ href: "/portal", label: "Overview" }, ...screens, ...objects]}
        label="Portal"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
