"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  BellRing,
  BarChart3,
  CalendarDays,
  CheckSquare,
  ChevronRight,
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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  collapseAll,
  expandAll,
  groupKey,
  isOpen,
  moduleKey,
  navStateCookie,
  NAV_STATE_COOKIE,
  parseNavState,
  revealActive,
  sectionStateKey,
  setOpen,
  type NavState,
} from "@/lib/nav/state";
import { activeTrail, treeKeys, type TreeSection } from "@/lib/nav/tree";
import { cn } from "@/lib/utils";

import { NAV_GROUPS, SIDEBAR_COOKIE, type NavIcon, type NavItem } from "./nav";
import { useNavBadges } from "./nav-badges";
import { useBadgedItems } from "./shell-data";

const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
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

/** A sidebar entry: a page, or a module with its sections (built by lib/nav/tree.ts on the server). */
export type SidebarNode = NavItem & { sections?: TreeSection[] };

function readClientNavState(): NavState | null {
  try {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith(NAV_STATE_COOKIE + "="))
      ?.slice(NAV_STATE_COOKIE.length + 1);
    return parseNavState(raw);
  } catch {
    return null;
  }
}

const countLabel = (n: number) => (n > 99 ? "99+" : String(n));

function CountPill({ n, label }: { n: number; label: string }) {
  return (
    <span
      className="bg-destructive ml-auto shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums"
      aria-label={`${n} ${label}`}
    >
      {countLabel(n)}
    </span>
  );
}

const Dot = () => (
  <span className="bg-destructive absolute -top-1 -right-1 size-2 rounded-full" aria-hidden />
);

export function Sidebar({
  tree: rawTree,
  orgName,
  defaultCollapsed,
  navState,
  className,
  onNavigate,
}: {
  tree: readonly SidebarNode[];
  orgName: string;
  defaultCollapsed: boolean;
  /** Expanded modules and minimised sections/groups, read from the cookie by the server layout. */
  navState: NavState;
  className?: string;
  /** Set when the sidebar sits in the phone drawer (closes it after a tap). */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const tree = useBadgedItems(rawTree);
  const counts = useNavBadges();
  const uid = useId();
  const inDrawer = !!onNavigate;
  const [collapsedPref, setCollapsed] = useState(defaultCollapsed);
  const collapsed = collapsedPref && !inDrawer;

  const trail = useMemo(() => {
    const t = activeTrail(tree, pathname);
    return { ...t, group: tree.find((n) => n.href === t.item)?.group };
  }, [tree, pathname]);
  const keys = useMemo(() => treeKeys(tree), [tree]);

  // The drawer mounts in the browser only, so it can read the cookie as it is now.
  const [nav, setNav] = useState<NavState>(() =>
    revealActive((inDrawer && readClientNavState()) || navState, trail),
  );
  useEffect(() => {
    setNav((s) => revealActive(s, trail));
    // only when you move into another module, section or group
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail.module, trail.section, trail.group]);
  const persisted = useRef(false);
  useEffect(() => {
    if (!persisted.current) {
      persisted.current = true;
      return;
    }
    document.cookie = navStateCookie(nav);
  }, [nav]);

  function toggleRail() {
    const next = !collapsedPref;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  const toggle = (key: string, open: boolean) => setNav((s) => setOpen(s, key, open));
  const moduleTotal = (node: SidebarNode) =>
    (node.sections ?? []).reduce(
      (sum, s) => sum + s.pages.reduce((x, p) => x + (counts[p.href] ?? 0), 0),
      0,
    );

  const rowClass = (active: boolean) =>
    cn(
      "flex h-9 min-w-0 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors",
      "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      active && "bg-sidebar-accent text-sidebar-accent-foreground",
    );

  function renderLeaf(item: SidebarNode) {
    const Icon = ICONS[item.icon];
    const active = trail.item === item.href;
    const link = (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(rowClass(active), collapsed && "justify-center px-0")}
      >
        <span className="relative flex shrink-0">
          <Icon className="size-4" />
          {collapsed && item.badge ? <Dot /> : null}
        </span>
        {!collapsed && <span className="truncate">{item.label}</span>}
        {!collapsed && item.badge ? <CountPill n={item.badge} label="overdue" /> : null}
      </Link>
    );
    return collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    ) : (
      link
    );
  }

  function renderModule(node: SidebarNode, sections: TreeSection[], index: number) {
    const Icon = ICONS[node.icon];
    const inside = trail.module === node.href;
    const total = moduleTotal(node);
    if (collapsed)
      return (
        <ModuleFlyout
          node={node}
          sections={sections}
          Icon={Icon}
          active={inside}
          activePage={trail.page}
          dot={total > 0}
          counts={counts}
        />
      );
    const open = isOpen(nav, moduleKey(node.href), inside);
    const id = `${uid}-m${index}`;
    return (
      <>
        <div className="flex items-center gap-0.5">
          <Link
            href={node.href}
            onClick={onNavigate}
            aria-current={inside && !trail.page ? "page" : undefined}
            className={cn(
              rowClass(inside && !open),
              "flex-1",
              inside && open && "text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{node.label}</span>
            {!open && total > 0 ? <CountPill n={total} label="waiting" /> : null}
          </Link>
          <button
            type="button"
            data-slot="nav-toggle"
            aria-expanded={open}
            aria-controls={id}
            aria-label={`${open ? "Hide" : "Show"} ${node.label} pages`}
            onClick={() => toggle(moduleKey(node.href), !open)}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex size-9 shrink-0 items-center justify-center rounded-md"
          >
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
        </div>
        {open && (
          <div id={id} className="border-sidebar-border mt-0.5 mb-1 ml-[1.15rem] border-l pl-2">
            {sections.map((s, j) => {
              const sOpen = isOpen(nav, sectionStateKey(s.key), true);
              const sid = `${id}-s${j}`;
              const hidden = s.pages.reduce((x, p) => x + (counts[p.href] ?? 0), 0);
              return (
                <div key={s.key}>
                  <button
                    type="button"
                    data-slot="nav-toggle"
                    aria-expanded={sOpen}
                    aria-controls={sid}
                    onClick={() => toggle(sectionStateKey(s.key), !sOpen)}
                    className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 rounded px-1.5 pt-2 pb-1 text-left text-[10px] font-semibold tracking-wide uppercase"
                  >
                    <ChevronRight
                      className={cn("size-3 shrink-0 transition-transform", sOpen && "rotate-90")}
                      aria-hidden
                    />
                    <span className="truncate">{s.title}</span>
                    {!sOpen && hidden > 0 ? (
                      <span className="bg-destructive ml-auto size-1.5 rounded-full" aria-hidden />
                    ) : null}
                  </button>
                  {sOpen && (
                    <ul id={sid} className="flex flex-col gap-px">
                      {s.pages.map((p) => {
                        const active = trail.page === p.href;
                        const n = counts[p.href] ?? 0;
                        return (
                          <li key={p.href}>
                            <Link
                              href={p.href}
                              onClick={onNavigate}
                              aria-current={active ? "page" : undefined}
                              className={cn(
                                "text-muted-foreground flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
                                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                                active &&
                                  "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                              )}
                            >
                              <span className="truncate">{p.label}</span>
                              {n > 0 ? <CountPill n={n} label="waiting" /> : null}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  }

  let moduleIndex = 0;
  function renderItem(item: SidebarNode) {
    return (
      <li key={item.href}>
        {item.sections ? renderModule(item, item.sections, moduleIndex++) : renderLeaf(item)}
      </li>
    );
  }

  const top = tree.filter((i) => !i.group && i.icon !== "settings");
  const bottom = tree.filter((i) => !i.group && i.icon === "settings");

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
          "flex h-14 shrink-0 items-center gap-2 border-b px-3",
          collapsed && "justify-center px-0",
        )}
      >
        <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <Activity className="size-4" />
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm leading-tight font-semibold">Pulse</div>
            <div className="text-muted-foreground truncate text-xs leading-tight">{orgName}</div>
          </div>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        {!collapsed && keys.modules.length > 0 && (
          <div className="text-muted-foreground -mt-1 mb-1 flex justify-end gap-2 px-1 text-[11px]">
            <button
              type="button"
              data-slot="nav-toggle"
              className="hover:text-foreground"
              onClick={() => setNav((s) => expandAll(s, keys.modules))}
            >
              Expand all
            </button>
            <button
              type="button"
              data-slot="nav-toggle"
              className="hover:text-foreground"
              onClick={() => setNav((s) => collapseAll(s, keys.modules))}
            >
              Collapse all
            </button>
          </div>
        )}
        <ul className="flex flex-col gap-0.5">{top.map(renderItem)}</ul>
        {NAV_GROUPS.map((group, g) => {
          const groupItems = tree.filter((i) => i.group === group);
          if (groupItems.length === 0) return null;
          const gOpen = collapsed || isOpen(nav, groupKey(group), true);
          const gid = `${uid}-g${g}`;
          return (
            <div key={group} className="mt-3">
              {collapsed ? (
                <div className="bg-border mx-2 mb-1.5 h-px" aria-hidden />
              ) : (
                <button
                  type="button"
                  data-slot="nav-toggle"
                  aria-expanded={gOpen}
                  aria-controls={gid}
                  onClick={() => toggle(groupKey(group), !gOpen)}
                  className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 px-2.5 pb-1 text-left text-[11px] font-semibold tracking-wide uppercase"
                >
                  <span className="truncate">{group}</span>
                  <ChevronRight
                    className={cn(
                      "ml-auto size-3 shrink-0 transition-transform",
                      gOpen && "rotate-90",
                    )}
                    aria-hidden
                  />
                </button>
              )}
              {gOpen && (
                <ul id={gid} className="flex flex-col gap-0.5">
                  {groupItems.map(renderItem)}
                </ul>
              )}
            </div>
          );
        })}
        {bottom.length > 0 && (
          <>
            <div className="bg-border mx-2 mt-3 mb-1.5 h-px" aria-hidden />
            <ul className="flex flex-col gap-0.5">{bottom.map(renderItem)}</ul>
          </>
        )}
      </nav>

      {!inDrawer && (
        <div className="flex flex-col gap-0.5 border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleRail}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            className={cn("w-full justify-start", collapsed && "justify-center px-0")}
          >
            {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
            {!collapsed && <span>Collapse</span>}
          </Button>
        </div>
      )}
    </aside>
  );
}

/**
 * A module in the collapsed rail: hovering (mouse) or pressing the icon opens its sections and pages beside the rail.
 * Radix gives the keyboard behaviour: Enter, Space or Down opens and focuses the first page, the arrow keys move,
 * Escape closes and returns focus to the icon.
 */
function ModuleFlyout({
  node,
  sections,
  Icon,
  active,
  activePage,
  dot,
  counts,
}: {
  node: SidebarNode;
  sections: TreeSection[];
  Icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  activePage?: string;
  dot: boolean;
  counts: Readonly<Record<string, number>>;
}) {
  const [open, setOpenState] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpenState(next), ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(o) => {
        clear();
        setOpenState(o);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${node.label} menu`}
          onPointerEnter={(e) => e.pointerType === "mouse" && later(true, 120)}
          onPointerLeave={(e) => e.pointerType === "mouse" && later(false, 200)}
          onPointerDown={(e) => {
            // already opened by hovering: a click keeps it open instead of toggling it shut
            if (e.pointerType === "mouse" && open) e.preventDefault();
          }}
          className={cn(
            "flex h-9 w-full items-center justify-center rounded-md transition-colors",
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            (active || open) && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <span className="relative flex shrink-0">
            <Icon className="size-4" />
            {dot ? <Dot /> : null}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="w-60"
        onPointerEnter={clear}
        onPointerLeave={() => later(false, 200)}
      >
        <DropdownMenuItem asChild>
          <Link href={node.href} className="font-semibold">
            {node.label}
          </Link>
        </DropdownMenuItem>
        {sections.map((s) => (
          <Fragment key={s.key}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground py-1 text-[10px] font-semibold tracking-wide uppercase">
              {s.title}
            </DropdownMenuLabel>
            {s.pages.map((p) => {
              const n = counts[p.href] ?? 0;
              return (
                <DropdownMenuItem key={p.href} asChild>
                  <Link
                    href={p.href}
                    aria-current={activePage === p.href ? "page" : undefined}
                    className={cn(activePage === p.href && "bg-accent/60 font-medium")}
                  >
                    <span className="truncate">{p.label}</span>
                    {n > 0 ? <CountPill n={n} label="waiting" /> : null}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
