import { requireMember } from "@/lib/auth/session";

import { RecallTabs } from "./recall-tabs";
import { recallTabsFor } from "./tabs";

export default async function RecallLayout({ children }: { children: React.ReactNode }) {
  // only the tabs this member may open (Parallel run needs reports.view, the others campaigns.view)
  const member = await requireMember();
  return (
    <div className="flex flex-col gap-4">
      <RecallTabs tabs={recallTabsFor(member)} />
      {children}
    </div>
  );
}
