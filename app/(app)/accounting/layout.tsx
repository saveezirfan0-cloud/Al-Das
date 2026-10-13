import { requireMember } from "@/lib/auth/session";
import { accountingNavFor } from "@/lib/accounting/nav";

import { SettingsNav } from "../settings/settings-nav";

/** Accounting module shell (Phase 22A). Each page checks its own permission again. Query-free. */
export default async function AccountingLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const items = accountingNavFor(member);
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SettingsNav items={items} label="Accounting" mobileOnly />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
