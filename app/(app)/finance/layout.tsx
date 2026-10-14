import { enforceFinanceWindow, requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { financeNavFor } from "@/lib/finance/nav";
import { loadFinanceBadges } from "@/lib/finance/nav-badges";
import { createClient } from "@/lib/supabase/server";

import { PublishNavBadges } from "@/components/shell/nav-badges";

import { SettingsNav } from "../settings/settings-nav";

/** Finance & Insurance module shell. Each tab is gated again on its own page. */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  // finance access window (Settings, Security): outside it, explain instead of showing the module
  await enforceFinanceWindow(member);
  const supabase = await createClient();
  // counts are read with the member's own client, only for the tabs they can see
  const badges = await loadFinanceBadges(supabase, member, todayIn(member.org.timezone));
  const items = financeNavFor(member, badges);

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      {/* phones keep this menu; from md up the sidebar tree lists the same pages and shows these counts */}
      <div className="contents print:hidden">
        <SettingsNav items={items} label="Finance" mobileOnly />
      </div>
      <PublishNavBadges
        counts={Object.fromEntries(items.filter((i) => i.badge).map((i) => [i.href, i.badge!]))}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
