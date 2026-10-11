import { visibleSettingsPages } from "@/components/shell/settings-pages";
import { requireMember } from "@/lib/auth/session";

import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const items = visibleSettingsPages(member).map((p) => ({
    href: p.href,
    label: p.label,
    section: p.section,
  }));
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SettingsNav items={items} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
