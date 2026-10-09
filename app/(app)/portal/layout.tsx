import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

import { SettingsNav } from "../settings/settings-nav";
import { PORTAL_SECTIONS } from "./sections";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const items = PORTAL_SECTIONS.filter((s) => can(member, s.read)).map((s) => ({
    href: s.href,
    label: s.label,
  }));
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SettingsNav items={[{ href: "/portal", label: "Overview" }, ...items]} label="Portal" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
