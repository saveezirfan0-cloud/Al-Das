"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  BellRing,
  BarChart3,
  Building2,
  ClipboardList,
  Gauge,
  BookOpenCheck,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
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
  Stethoscope,
  Sunrise,
  UsersRound,
  Network,
  Workflow,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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

import { NAV_GROUPS, type NavIcon, type NavItem } from "./nav";
import { useNavBadges } from "./nav-badges";
import { useBadgedItems } from "./shell-data";

export const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  frontdesk: ConciergeBell,
  myday: Sunrise,
  doctors: Stethoscope,
  staff: UsersRound,
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
  followups: ClipboardList,
  teams: Network,
  branches: Building2,
  management: Gauge,
  portal: LayoutGrid,
  reports: BarChart3,
  finance: Landmark,
  accounting: BookOpenCheck,
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

export function CountPill({ n, label }: { n: number; label: string }) {
  return (
    <>
      <span
        className="bg-destructive ml-auto shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums"
        aria-hidden
      >
        {countLabel(n)}
      </span>
      <span className="sr-only">
        , {n} {label}
      </span>
    </>
  );
}

export function Sidebar({
  tree: rawTree,
  orgName,
  navState,
  className,
  onNavigate,
  branchSwitcher,
}: {
  tree: readonly SidebarNode[];
  orgName: string;
  /** Expanded modules and minimised sections/groups, read from the cookie by the server layout. */
  navState: NavState;
  className?: string;
  /** Closes the phone drawer after a tap. */
  onNavigate?: () => void;
  /** The branch switcher (components/shell/branch-switcher.tsx), shown above the menu. */
  branchSwitcher?: React.ReactNode;
}) {
  const pathname = usePathname();
  const tree = useBadgedItems(rawTree);
  const counts = useNavBadges();
  const uid = useId();
  const inDrawer = !!onNavigate;

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

  // One header button instead of two text links: collapse when every module is open, otherwise expand.
  const allOpen = keys.modules.every((m) => isOpen(nav, moduleKey(m), m === trail.module));

  const toggle = (key: string, open: boolean) => setNav((s) => setOpen(s, key, open));
  const moduleTotal = (node: SidebarNode) =>
    (node.sections ?? []).reduce(
      (sum, s) => sum + s.pages.reduce((x, p) => x + (counts[p.href] ?? 0), 0),
      0,
    );

  const rowClass = (active: boolean) =>
    cn(
      "group/nav relative flex h-9 min-w-0 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors outline-none",
      "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-2",
      active && "bg-sidebar-accent text-sidebar-accent-foreground",
    );

  function renderLeaf(item: SidebarNode) {
    const Icon = ICONS[item.icon];
    const active = trail.item === item.href;
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={rowClass(active)}
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
        </span>
        <span className="truncate">{item.label}</span>
        {item.badge ? <CountPill n={item.badge} label="overdue" /> : null}
      </Link>
    );
  }

  function renderModule(node: SidebarNode, sections: TreeSection[], index: number) {
    const Icon = ICONS[node.icon];
    const inside = trail.module === node.href;
    const total = moduleTotal(node);
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
            <Icon
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                inside
                  ? "text-sidebar-primary"
                  : "text-muted-foreground group-hover/nav:text-sidebar-accent-foreground",
              )}
            />
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
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full w-60 flex-col border-r",
        className,
      )}
    >
      <div className="flex h-14 shrink-0 items-center border-b px-2">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-label="Pulse home"
          className="focus-visible:ring-sidebar-ring flex min-w-0 items-center gap-2 rounded-md p-1 outline-none focus-visible:ring-2"
        >
          <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Activity className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm leading-tight font-semibold">Pulse</span>
            <span className="text-muted-foreground block truncate text-xs leading-tight">
              {orgName}
            </span>
          </span>
        </Link>
        {keys.modules.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground ml-auto shrink-0"
            aria-label={allOpen ? "Collapse all menus" : "Expand all menus"}
            onClick={() =>
              setNav((s) => (allOpen ? collapseAll(s, keys.modules) : expandAll(s, keys.modules)))
            }
          >
            {allOpen ? <ChevronsDownUp aria-hidden /> : <ChevronsUpDown aria-hidden />}
          </Button>
        )}
      </div>

      {branchSwitcher && <div className="shrink-0 border-b p-2">{branchSwitcher}</div>}
      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">{top.map(renderItem)}</ul>
        {NAV_GROUPS.map((group, g) => {
          const groupItems = tree.filter((i) => i.group === group);
          if (groupItems.length === 0) return null;
          const gOpen = isOpen(nav, groupKey(group), true);
          const gid = `${uid}-g${g}`;
          return (
            <div key={group} className="mt-3">
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
              {gOpen && (
                <ul id={gid} className="flex flex-col gap-0.5">
                  {groupItems.map((item, n) => (
                    <Fragment key={item.href}>
                      {item.subgroup && item.subgroup !== groupItems[n - 1]?.subgroup && (
                        <li
                          role="presentation"
                          className="text-muted-foreground px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide uppercase"
                        >
                          {item.subgroup}
                        </li>
                      )}
                      {renderItem(item)}
                    </Fragment>
                  ))}
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
    </aside>
  );
}
