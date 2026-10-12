"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

import { OPEN_PALETTE_EVENT } from "./command-palette";
import { OPEN_NAV_EVENT } from "./mobile-tabs";
import { NotificationsMenu, type NotificationItem } from "./notifications-menu";
import type { NavItem } from "./nav";
import { Sidebar } from "./sidebar";
import { UserMenu, type UserMenuProps } from "./user-menu";

export function Topbar({
  items,
  orgName,
  notifications,
  user,
}: {
  items: readonly NavItem[];
  orgName: string;
  notifications: NotificationItem[];
  user: UserMenuProps;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_NAV_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NAV_EVENT, onOpen);
  }, []);

  const current = items.find((i) => pathname === i.href || pathname.startsWith(i.href + "/"));

  return (
    <header className="bg-background flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 p-0 sm:max-w-64">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar
            items={items}
            orgName={orgName}
            defaultCollapsed={false}
            className="w-full border-0"
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <h1 className="truncate text-base font-semibold">{current?.label ?? "Pulse"}</h1>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hidden w-56 justify-between font-normal md:inline-flex"
          onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
          aria-label="Quick search"
        >
          <span className="flex items-center gap-2">
            <Search className="size-3.5" /> Search pages…
          </span>
          <kbd className="bg-muted rounded px-1.5 font-mono text-[10px]">Ctrl K</kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
          aria-label="Quick search"
        >
          <Search />
        </Button>
        <NotificationsMenu initial={notifications} orgId={user.orgId} userId={user.userId} />
        <UserMenu {...user} />
      </div>
    </header>
  );
}
