"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  BellRing,
  BarChart3,
  CalendarDays,
  CheckSquare,
  ChevronsLeft,
  ChevronsRight,
  Contact,
  Landmark,
  FileText,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  LayoutGrid,
  Megaphone,
  Settings,
  Workflow,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { NAV_GROUPS, SIDEBAR_COOKIE, type NavIcon, type NavItem } from "./nav";

const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  inbox: Inbox,
  contacts: Contact,
  enquiries: KanbanSquare,
  tasks: CheckSquare,
  appointments: CalendarDays,
  campaigns: Megaphone,
  templates: FileText,
  flows: Workflow,
  recall: BellRing,
  portal: LayoutGrid,
  reports: BarChart3,
  finance: Landmark,
  settings: Settings,
};

export function Sidebar({
  items,
  orgName,
  defaultCollapsed,
  className,
  onNavigate,
}: {
  items: readonly NavItem[];
  orgName: string;
  defaultCollapsed: boolean;
  className?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  const top = items.filter((i) => !i.group && i.icon !== "settings");
  const bottom = items.filter((i) => !i.group && i.icon === "settings");

  function renderItem(item: NavItem) {
    const Icon = ICONS[item.icon];
    const active = pathname === item.href || pathname.startsWith(item.href + "/");
    const link = (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        <span className="relative flex shrink-0">
          <Icon className="size-4" />
          {collapsed && item.badge ? (
            <span
              className="bg-destructive absolute -top-1 -right-1 size-2 rounded-full"
              aria-hidden
            />
          ) : null}
        </span>
        {!collapsed && <span className="truncate">{item.label}</span>}
        {!collapsed && item.badge ? (
          <span
            className="bg-destructive ml-auto rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums"
            aria-label={`${item.badge} overdue`}
          >
            {item.badge > 99 ? "99+" : item.badge}
          </span>
        ) : null}
      </Link>
    );
    return (
      <li key={item.href}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ) : (
          link
        )}
      </li>
    );
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full flex-col border-r transition-[width] duration-200",
        collapsed ? "w-14" : "w-60",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center gap-2 border-b px-3",
          collapsed && "justify-center px-0",
        )}
      >
        <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <Activity className="size-4" />
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight">Pulse</div>
            <div className="text-muted-foreground truncate text-xs leading-tight">{orgName}</div>
          </div>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">{top.map(renderItem)}</ul>
        {NAV_GROUPS.map((group) => {
          const groupItems = items.filter((i) => i.group === group);
          if (groupItems.length === 0) return null;
          return (
            <div key={group} className="mt-3">
              {collapsed ? (
                <div className="bg-border mx-2 mb-1.5 h-px" aria-hidden />
              ) : (
                <p className="text-muted-foreground px-2.5 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                  {group}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">{groupItems.map(renderItem)}</ul>
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        {bottom.map(renderItem)}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className={cn("w-full justify-start", collapsed && "justify-center px-0")}
        >
          {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
          {!collapsed && <span>Collapse</span>}
        </Button>
      </div>
    </aside>
  );
}
