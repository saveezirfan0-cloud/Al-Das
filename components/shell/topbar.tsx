"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

import { HelpMenu } from "@/components/help/help-menu";
import type { NavState } from "@/lib/nav/state";
import { currentItem } from "@/lib/nav/tree";

import { OPEN_PALETTE_EVENT } from "./command-palette";
import { OPEN_NAV_EVENT } from "./mobile-tabs";
import { NotificationsMenu } from "./notifications-menu";
import { Sidebar, type SidebarNode } from "./sidebar";
import { UserMenu, type UserMenuProps } from "./user-menu";

export function Topbar({
  items,
  navState,
  orgName,
  user,
  helpVideos,
  branchSwitcher,
}: {
  items: readonly SidebarNode[];
  navState: NavState;
  orgName: string;
  user: UserMenuProps;
  /** Recorded training clips by id (orgs.settings.help.videos), for the ? button. */
  helpVideos: Record<string, string>;
  /** The phone drawer's branch switcher. */
  branchSwitcher?: React.ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_NAV_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NAV_EVENT, onOpen);
  }, []);
  // The server cannot know the platform, so it renders "Ctrl K" and Macs switch after mount.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    setIsMac(/mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? ""));
  }, []);

  // the most specific item: /dashboard/management is Management, /staff/rota is Rota, and an entry whose href
  // carries a query (CRM Branches, /settings/appointments?tab=locations) wins only on that same query
  const current = currentItem(items, pathname, search);

  return (
    <header className="bg-background flex h-14 shrink-0 items-center gap-3 border-b px-4 print:hidden">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
      >
        <Menu aria-hidden />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-60 p-0 sm:max-w-60">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar
            tree={items}
            navState={navState}
            orgName={orgName}
            className="w-full border-0"
            onNavigate={() => setOpen(false)}
            branchSwitcher={branchSwitcher}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 items-center gap-1.5">
        {current?.group && (
          <>
            <span className="text-muted-foreground hidden shrink-0 text-sm sm:inline">
              {current.group}
            </span>
            <span className="text-muted-foreground hidden text-sm sm:inline" aria-hidden>
              /
            </span>
          </>
        )}
        <h1 className="truncate text-base font-semibold">{current?.label ?? "Pulse"}</h1>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hidden w-56 justify-between font-normal md:inline-flex"
          onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
          aria-label="Quick search"
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        >
          <span className="flex items-center gap-2">
            <Search className="size-3.5" aria-hidden /> Search…
          </span>
          <kbd className="bg-muted rounded px-1.5 font-mono text-[10px]" aria-hidden>
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
          aria-label="Quick search"
        >
          <Search aria-hidden />
        </Button>
        <HelpMenu roleName={user.roleName} videos={helpVideos} />
        <NotificationsMenu />
        <UserMenu {...user} />
      </div>
    </header>
  );
}
