"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";
import {
  Activity,
  BellRing,
  BarChart3,
  CalendarDays,
  CheckSquare,
  ChevronsLeft,
  ChevronsRight,
  ConciergeBell,
  Contact,
  Landmark,
  FileText,
  Images,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  LayoutGrid,
  Megaphone,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { NAV_GROUPS, SIDEBAR_COOKIE, type NavIcon, type NavItem } from "./nav";
import { useBadgedItems } from "./shell-data";

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  frontdesk: ConciergeBell,
  inbox: Inbox,
  contacts: Contact,
  enquiries: KanbanSquare,
  tasks: CheckSquare,
  appointments: CalendarDays,
  campaigns: Megaphone,
  templates: FileText,
  flows: Workflow,
  media: Images,
  recall: BellRing,
  portal: LayoutGrid,
  reports: BarChart3,
  finance: Landmark,
  settings: Settings,
};

export function Sidebar({
  items: rawItems,
  orgName,
  defaultCollapsed,
  className,
  onNavigate,
  collapsible = true,
}: {
  items: readonly NavItem[];
  orgName: string;
  defaultCollapsed: boolean;
  className?: string;
  onNavigate?: () => void;
  /** False inside the phone sheet, where collapsing makes no sense. */
  collapsible?: boolean;
}) {
  const pathname = usePathname();
  const items = useBadgedItems(rawItems);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const groupId = useId();

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
          "group/nav relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors outline-none",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-2",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        {active && (
          <span
            className="bg-sidebar-primary absolute inset-y-1.5 left-0 w-[3px] rounded-r-full"
            aria-hidden
          />
        )}
        <span className="relative flex shrink-0">
          <Icon
            aria-hidden
            className={cn(
              "size-4",
              active
                ? "text-sidebar-primary"
                : "text-muted-foreground group-hover/nav:text-sidebar-accent-foreground",
            )}
          />
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
            aria-hidden
          >
            {item.badge > 99 ? "99+" : item.badge}
          </span>
        ) : null}
        {/* Only Tasks carries a badge (useBadgedItems): the count of overdue tasks. */}
        {item.badge ? <span className="sr-only">, {item.badge} overdue</span> : null}
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
        className={cn("flex h-14 items-center border-b px-2", collapsed && "justify-center px-0")}
      >
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-label="Pulse home"
          className="focus-visible:ring-sidebar-ring flex min-w-0 items-center gap-2 rounded-md p-1 outline-none focus-visible:ring-2"
        >
          <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Activity className="size-4" aria-hidden />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm leading-tight font-semibold">Pulse</span>
              <span className="text-muted-foreground block truncate text-xs leading-tight">
                {orgName}
              </span>
            </span>
          )}
        </Link>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">{top.map(renderItem)}</ul>
        {NAV_GROUPS.map((group, index) => {
          const groupItems = items.filter((i) => i.group === group);
          if (groupItems.length === 0) return null;
          const labelId = `${groupId}-group-${index}`;
          return (
            <div
              key={group}
              role="group"
              aria-labelledby={collapsed ? undefined : labelId}
              aria-label={collapsed ? group : undefined}
              className="mt-3"
            >
              {collapsed ? (
                <div className="bg-border mx-2 mb-1.5 h-px" aria-hidden />
              ) : (
                <p
                  id={labelId}
                  className="text-muted-foreground px-2.5 pb-1 text-[11px] font-semibold tracking-wide uppercase"
                >
                  {group}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">{groupItems.map(renderItem)}</ul>
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        <ul className="flex flex-col gap-0.5">{bottom.map(renderItem)}</ul>
        {collapsible && (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggle}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            className={cn(
              "text-muted-foreground w-full justify-start",
              collapsed && "justify-center px-0",
            )}
          >
            {collapsed ? <ChevronsRight aria-hidden /> : <ChevronsLeft aria-hidden />}
            {!collapsed && <span>Collapse</span>}
          </Button>
        )}
      </div>
    </aside>
  );
}
