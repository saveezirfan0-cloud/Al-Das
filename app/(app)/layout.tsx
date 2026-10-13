import { cookies } from "next/headers";

import { CommandPalette } from "@/components/shell/command-palette";
import { MobileTabs } from "@/components/shell/mobile-tabs";
import { NAV_ITEMS, SIDEBAR_COOKIE } from "@/components/shell/nav";
import { NavBadgesProvider } from "@/components/shell/nav-badges";
import { ShellDataProvider } from "@/components/shell/shell-data";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TrainingBanner } from "@/components/shell/training-banner";
import { can } from "@/lib/auth/can";
import { readHelpSettings } from "@/lib/help/clips";
import { requireMember } from "@/lib/auth/session";
import { NAV_MODULES } from "@/lib/nav/modules";
import { NAV_STATE_COOKIE, parseNavState } from "@/lib/nav/state";
import { buildNavTree } from "@/lib/nav/tree";
import type { QuickLink } from "@/lib/shell/quick-links";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const cookieStore = await cookies();
  const collapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "1";
  const navState = parseNavState(cookieStore.get(NAV_STATE_COOKIE)?.value);

  // The overdue-task badge and the notification list are fetched in the browser and kept fresh by Realtime
  // (components/shell/shell-data.tsx), so this layout no longer runs two queries on every page render. The tree is
  // pure: module pages come from lib/nav/modules.ts and are filtered by the member's permissions, no query.
  const items = buildNavTree(NAV_ITEMS, NAV_MODULES, member);

  const quickLinks: QuickLink[] = [
    {
      href: "/notifications",
      label: "Notification centre",
      keywords: ["alerts", "bell", "snooze", "unread"],
      hint: "Today",
    },
    {
      href: "/help/training",
      label: "Training and help",
      keywords: ["videos", "guides", "shortcuts", "what's new", "feedback", "onboarding", "?"],
      hint: "Help",
    },
    ...(can(member, "frontdesk.use")
      ? [
          {
            href: "/front-desk/end-of-day",
            label: "End of day sheet",
            keywords: ["handover", "print", "unconfirmed", "close up"],
            hint: "Front desk",
          },
          {
            href: "/front-desk/qr",
            label: "Desk QR code",
            keywords: ["poster", "register", "walk-in", "print"],
            hint: "Front desk",
          },
        ]
      : []),
    ...items.flatMap((i) => [
      { href: i.href, label: i.label, keywords: i.keywords, hint: i.group },
      // every registered module page, with "<module> · <section>" as context
      ...(i.sections ?? []).flatMap((s) =>
        s.pages.map((p) => ({
          href: p.href,
          label: p.label,
          keywords: p.keywords,
          hint: `${i.label} · ${s.title}`,
        })),
      ),
    ]),
  ];

  const name = `${member.profile.first_name} ${member.profile.last_name}`.trim();

  return (
    <TooltipProvider>
      <ShellDataProvider
        orgId={member.orgId}
        userId={member.userId}
        canTasks={can(member, "tasks.view")}
      >
        <NavBadgesProvider>
        <div className="flex h-svh overflow-hidden print:block print:h-auto print:overflow-visible">
          <Sidebar
            tree={items}
            navState={navState}
            orgName={member.org.name}
            defaultCollapsed={collapsed}
            className="hidden md:flex print:hidden"
          />
          <div className="flex min-w-0 flex-1 flex-col print:block">
            {member.org.is_training && <TrainingBanner />}
            <Topbar
              items={items}
              navState={navState}
              helpVideos={readHelpSettings(member.org.settings).videos}
              orgName={member.org.name}
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
            <main className="flex-1 overflow-y-auto p-4 pb-20 md:p-6 md:pb-6 print:overflow-visible print:p-0">
              {children}
            </main>
          </div>
        </div>
        <MobileTabs items={items} />
        <CommandPalette links={quickLinks} />
        </NavBadgesProvider>
      </ShellDataProvider>
    </TooltipProvider>
  );
}
