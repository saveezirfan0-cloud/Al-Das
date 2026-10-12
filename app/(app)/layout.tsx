import { cookies } from "next/headers";

import { CommandPalette } from "@/components/shell/command-palette";
import { MobileTabs } from "@/components/shell/mobile-tabs";
import { NAV_ITEMS, SIDEBAR_COOKIE } from "@/components/shell/nav";
import { visibleSettingsPages } from "@/components/shell/settings-pages";
import { ShellDataProvider } from "@/components/shell/shell-data";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TrainingBanner } from "@/components/shell/training-banner";
import { can, canAny } from "@/lib/auth/can";
import { readHelpSettings } from "@/lib/help/clips";
import { requireMember } from "@/lib/auth/session";
import type { QuickLink } from "@/lib/shell/quick-links";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const cookieStore = await cookies();
  const collapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "1";

  // The overdue-task badge and the notification list are fetched in the browser and kept fresh by Realtime
  // (components/shell/shell-data.tsx), so this layout no longer runs two queries on every page render.
  const items = NAV_ITEMS.filter(
    (i) =>
      (!i.permission || can(member, i.permission)) &&
      (!i.permissions || canAny(member, i.permissions)),
  );

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
    ...items.map((i) => ({ href: i.href, label: i.label, keywords: i.keywords, hint: i.group })),
    ...visibleSettingsPages(member).map((p) => ({
      href: p.href,
      label: p.label,
      keywords: p.keywords,
      hint: `Settings · ${p.section}`,
    })),
  ];

  const name = `${member.profile.first_name} ${member.profile.last_name}`.trim();

  return (
    <TooltipProvider>
      <ShellDataProvider
        orgId={member.orgId}
        userId={member.userId}
        canTasks={can(member, "tasks.view")}
      >
        <div className="flex h-svh overflow-hidden print:block print:h-auto print:overflow-visible">
          <Sidebar
            items={items}
            orgName={member.org.name}
            defaultCollapsed={collapsed}
            className="hidden md:flex print:hidden"
          />
          <div className="flex min-w-0 flex-1 flex-col print:block">
            {member.org.is_training && <TrainingBanner />}
            <Topbar
              items={items}
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
      </ShellDataProvider>
    </TooltipProvider>
  );
}
