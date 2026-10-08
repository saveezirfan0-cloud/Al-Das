"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

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
        <NotificationsMenu initial={notifications} orgId={user.orgId} userId={user.userId} />
        <UserMenu {...user} />
      </div>
    </header>
  );
}
