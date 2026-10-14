"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  ChevronRight,
  House,
  Landmark,
  MessagesSquare,
  Pin,
  PinOff,
  Sun,
  Users,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isOpen,
  navStateCookie,
  revealActive,
  sectionStateKey,
  setOpen,
  type NavState,
} from "@/lib/nav/state";
import { activeTrail } from "@/lib/nav/tree";
import { cn } from "@/lib/utils";

import { NAV_GROUPS, SIDEBAR_COOKIE, type NavGroup } from "./nav";
import { useNavBadges } from "./nav-badges";
import { useBadgedItems } from "./shell-data";
import { CountPill, ICONS, type SidebarNode } from "./sidebar";

/**
 * How each sidebar group appears as an area in the rail (docs/34 §3). "Back office" holds only modules with sections
 * (Finance, Accounting), which are areas of their own, so its entry shows only if a plain page is ever added to it.
 */
export const GROUP_AREAS: Record<NavGroup, { title: string; subtitle: string; icon: LucideIcon }> =
  {
    Today: { title: "Today", subtitle: "Front desk, diary, tasks and follow-ups", icon: Sun },
    Messaging: {
      title: "Messaging",
      subtitle: "Inbox, templates, campaigns and flows",
      icon: MessagesSquare,
    },
    CRM: { title: "CRM", subtitle: "Patients, enquiries and the organisation", icon: Users },
    "Back office": { title: "Back office", subtitle: "Finance and accounting", icon: Landmark },
    Insights: { title: "Insights", subtitle: "Reports, management and portal", icon: BarChart3 },
  };

/** One-line descriptions for the areas that are modules with their own sections. */
const MODULE_SUBTITLES: Record<string, string> = {
  "/finance": "Billing, claims and month-end",
  "/accounting": "Ledger, banking and reports",
  "/settings": "Workspace and your account",
};

export type Area = {
  key: string;
  title: string;
  subtitle: string;
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
  /** Where the rail icon goes: the area's first page. */
  href: string;
  /** Plain pages listed in the panel (a group area), or one module whose sections are listed. */
  items: SidebarNode[];
  module?: SidebarNode;
};

/**
 * Builds the rail areas from the tree: Dashboard is Home; each sidebar group is one area of plain pages, followed by an
 * area for each module with sections in that group (Finance, Accounting); Settings sits at the bottom. Areas the member
 * cannot see are dropped.
 */
export function buildAreas(tree: readonly SidebarNode[]): { top: Area[]; bottom: Area[] } {
  const top: Area[] = [];
  const bottom: Area[] = [];
  const moduleArea = (n: SidebarNode): Area => ({
    key: n.href,
    title: n.label,
    subtitle: MODULE_SUBTITLES[n.href] ?? "",
    icon: ICONS[n.icon],
    href: n.href,
    items: [],
    module: n,
  });
  const home = tree.find((n) => n.href === "/dashboard");
  if (home)
    top.push({
      key: "home",
      title: "Home",
      subtitle: "Your dashboard",
      icon: House,
      href: home.href,
      items: [home],
    });
  for (const group of NAV_GROUPS) {
    const items = tree.filter((n) => n.group === group && !n.sections);
    if (items.length > 0)
      top.push({ key: group, ...GROUP_AREAS[group], href: items[0].href, items });
    for (const n of tree) if (n.group === group && n.sections) top.push(moduleArea(n));
  }
  // modules outside the groups: Settings at the bottom, anything else at the end of the top list
  for (const n of tree)
    if (n.sections && !n.group) (n.icon === "settings" ? bottom : top).push(moduleArea(n));
  // Settings without sub-pages for this member still belongs at the bottom.
  const settings = tree.find((n) => n.icon === "settings" && !n.sections);
  if (settings)
    bottom.push({
      key: settings.href,
      title: settings.label,
      subtitle: MODULE_SUBTITLES[settings.href] ?? "",
      icon: ICONS.settings,
      href: settings.href,
      items: [settings],
    });
  return { top, bottom };
}

/**
 * Desktop navigation: a slim rail with one icon per area. Pointing at an area (or focusing it) pops its pages out in a
 * flyout; the pin in the flyout docks that area's panel beside the rail, and the pin in the docked panel undocks it.
 * Module sections fold away. An area with a single page (Home) shows a tooltip only. The phone drawer keeps the full
 * tree (sidebar.tsx).
 */
export function AppNav({
  tree: rawTree,
  orgName,
  navState,
  defaultPanelHidden,
  branchSwitcher,
}: {
  tree: readonly SidebarNode[];
  orgName: string;
  /** Minimised sections, read from the cookie by the server layout. */
  navState: NavState;
  defaultPanelHidden: boolean;
  /** The rail's branch switcher (components/shell/branch-switcher.tsx). */
  branchSwitcher?: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const tree = useBadgedItems(rawTree);
  const counts = useNavBadges();
  const uid = useId();

  const trail = useMemo(() => activeTrail(tree, pathname), [tree, pathname]);
  const { top, bottom } = useMemo(() => buildAreas(tree), [tree]);
  const area = [...top, ...bottom].find((a) =>
    a.module ? a.module.href === trail.item : a.items.some((i) => i.href === trail.item),
  );
  const hasPanel = (a: Area | undefined) => !!a && (!!a.module || a.items.length > 1);

  const [panelHidden, setPanelHidden] = useState(defaultPanelHidden);
  const [nav, setNav] = useState<NavState>(() => revealActive(navState, trail));
  useEffect(() => {
    setNav((s) => revealActive(s, trail));
    // only when you move into another module or section
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail.module, trail.section]);
  const persisted = useRef(false);
  useEffect(() => {
    if (!persisted.current) {
      persisted.current = true;
      return;
    }
    document.cookie = navStateCookie(nav);
  }, [nav]);

  function savePanelHidden(hidden: boolean) {
    setPanelHidden(hidden);
    document.cookie = `${SIDEBAR_COOKIE}=${hidden ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  // Flyout with hover intent: a short delay each way, so sweeping across the rail doesn't flash panels and moving
  // from the icon into the flyout doesn't close it.
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const docked = hasPanel(area) && !panelHidden;
  const peekArea = [...top, ...bottom].find((a) => a.key === peekKey);
  function openPeek(a: Area) {
    clearTimeout(timer.current);
    // The docked area is already on screen; other single-page areas have nothing to show.
    if (!hasPanel(a) || (docked && a.key === area?.key)) {
      setPeekKey(null);
      return;
    }
    timer.current = setTimeout(() => setPeekKey(a.key), peekKey ? 0 : 120);
  }
  function keepPeek() {
    clearTimeout(timer.current);
  }
  function closePeek(delay = 180) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPeekKey(null), delay);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setPeekKey(null), [pathname]);
  useEffect(() => {
    if (!peekKey) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPeekKey(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [peekKey]);

  /** Docks an area's panel; pinning another area also opens its first page. */
  function pin(a: Area) {
    savePanelHidden(false);
    setPeekKey(null);
    if (a.key !== area?.key) router.push(a.href);
  }

  const pageCount = (href: string) => counts[href] ?? 0;
  const areaCount = (a: Area) =>
    a.module
      ? (a.module.sections ?? []).reduce(
          (sum, s) => sum + s.pages.reduce((x, p) => x + pageCount(p.href), 0),
          0,
        )
      : a.items.reduce((sum, i) => sum + (i.badge ?? 0), 0);

  function railItem(a: Area) {
    const Icon = a.icon;
    const active = area?.key === a.key;
    const flyout = hasPanel(a);
    const link = (
      <Link
        href={a.href}
        aria-label={a.title}
        aria-current={active ? "page" : undefined}
        aria-haspopup={flyout ? "true" : undefined}
        aria-expanded={flyout ? peekKey === a.key : undefined}
        onMouseEnter={() => openPeek(a)}
        onMouseLeave={() => closePeek()}
        onFocus={() => openPeek(a)}
        className="group/item relative flex justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        {active && (
          <span
            className="bg-brand-accent absolute top-2.5 -left-3 h-6 w-1 rounded-r-full"
            aria-hidden
          />
        )}
        <span
          className={cn(
            "relative flex size-11 items-center justify-center rounded-xl transition-colors",
            active
              ? "bg-rail-active text-rail-active-foreground shadow-sm"
              : "bg-rail-muted text-rail-foreground group-hover/item:bg-rail-hover",
          )}
        >
          <Icon className="size-5" aria-hidden />
          {areaCount(a) > 0 && (
            <span
              className="bg-destructive ring-rail absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2"
              aria-hidden
            />
          )}
        </span>
      </Link>
    );
    return (
      <li key={a.key}>
        {flyout ? (
          link
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right" className="flex flex-col items-start gap-0">
              <span className="font-medium">{a.title}</span>
              {a.subtitle && <span className="opacity-75">{a.subtitle}</span>}
            </TooltipContent>
          </Tooltip>
        )}
      </li>
    );
  }

  const pageClass = (active: boolean) =>
    cn(
      "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors outline-none",
      "focus-visible:ring-sidebar-ring focus-visible:ring-2",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
    );

  function panelBody(a: Area) {
    if (!a.module)
      return (
        <ul className="flex flex-col gap-1">
          {a.items.map((i, n) => {
            const Icon = ICONS[i.icon];
            const active = trail.item === i.href;
            const heading = i.subgroup && i.subgroup !== a.items[n - 1]?.subgroup;
            return (
              <li key={i.href}>
                {heading && (
                  <p className="text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                    {i.subgroup}
                  </p>
                )}
                <Link
                  href={i.href}
                  aria-current={active ? "page" : undefined}
                  className={pageClass(active)}
                >
                  <Icon
                    className={cn("size-[18px] shrink-0", active ? "text-primary" : "opacity-70")}
                    aria-hidden
                  />
                  <span className="truncate">{i.label}</span>
                  {i.badge ? <CountPill n={i.badge} label="overdue" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      );
    return (
      <div className="flex flex-col gap-1">
        {a.module.sections!.map((s, j) => {
          const sOpen = isOpen(nav, sectionStateKey(s.key), true);
          const sid = `${uid}-s${j}`;
          const waiting = s.pages.reduce((x, p) => x + pageCount(p.href), 0);
          return (
            <div key={s.key}>
              <button
                type="button"
                data-slot="nav-toggle"
                aria-expanded={sOpen}
                aria-controls={sid}
                onClick={() => setNav((st) => setOpen(st, sectionStateKey(s.key), !sOpen))}
                className="text-sidebar-foreground hover:bg-sidebar-accent/60 flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold"
              >
                <span className="truncate">{s.title}</span>
                {!sOpen && waiting > 0 ? (
                  <span className="bg-destructive size-1.5 rounded-full" aria-hidden />
                ) : null}
                <ChevronRight
                  className={cn(
                    "text-muted-foreground ml-auto size-4 shrink-0 transition-transform",
                    sOpen && "rotate-90",
                  )}
                  aria-hidden
                />
              </button>
              {sOpen && (
                <ul
                  id={sid}
                  className="border-sidebar-border mt-0.5 mb-1.5 ml-4 flex flex-col gap-0.5 border-l pl-2"
                >
                  {s.pages.map((p) => {
                    const active = trail.page === p.href;
                    const n = pageCount(p.href);
                    return (
                      <li key={p.href}>
                        <Link
                          href={p.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            pageClass(active),
                            "h-9 font-normal",
                            active && "font-medium",
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
    );
  }

  function panelHeader(a: Area, pinned: boolean) {
    const Icon = a.icon;
    return (
      <div className="flex h-16 shrink-0 items-center gap-3 px-4">
        <span className="bg-sidebar-accent text-sidebar-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{a.title}</span>
          {a.subtitle && (
            <span className="text-muted-foreground block truncate text-xs">{a.subtitle}</span>
          )}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => (pinned ? savePanelHidden(true) : pin(a))}
              aria-label={pinned ? `Unpin ${a.title} menu` : `Pin ${a.title} menu`}
              aria-pressed={pinned}
              className="text-muted-foreground"
            >
              {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {pinned ? "Unpin: show this menu only when you point at it" : "Pin this menu open"}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <>
      <nav
        aria-label="Main"
        className="bg-rail hidden w-[4.5rem] shrink-0 flex-col items-center md:flex print:hidden"
      >
        <Link
          href="/dashboard"
          aria-label={`Pulse, ${orgName}`}
          className="flex h-16 w-full shrink-0 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-inset"
        >
          <span className="bg-brand-accent text-rail-active-foreground flex size-11 items-center justify-center rounded-xl shadow-sm">
            <Activity className="size-5" aria-hidden />
          </span>
        </Link>
        {branchSwitcher && <div className="shrink-0 pb-3">{branchSwitcher}</div>}
        <div className="bg-rail-foreground/10 h-px w-10 shrink-0" aria-hidden />
        <div className="flex w-full flex-1 flex-col overflow-y-auto px-3 py-3 [scrollbar-width:none]">
          <ul className="flex flex-col gap-2">{top.map(railItem)}</ul>
        </div>
        <div className="border-rail-foreground/10 flex w-full shrink-0 flex-col gap-2 border-t px-3 py-3">
          <ul className="flex flex-col gap-2">{bottom.map(railItem)}</ul>
        </div>
      </nav>

      {docked && area && (
        <aside
          aria-label={`${area.title} pages`}
          className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-64 shrink-0 flex-col border-r md:flex print:hidden"
        >
          {panelHeader(area, true)}
          <nav aria-label={area.title} className="flex-1 overflow-y-auto px-3 pb-3">
            {panelBody(area)}
          </nav>
        </aside>
      )}

      {peekArea && (
        <aside
          aria-label={`${peekArea.title} pages`}
          onMouseEnter={keepPeek}
          onMouseLeave={() => closePeek()}
          onFocus={keepPeek}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closePeek(0);
          }}
          className="bg-sidebar text-sidebar-foreground border-sidebar-border animate-in fade-in slide-in-from-left-2 fixed inset-y-0 left-[4.5rem] z-40 hidden w-64 flex-col border-r shadow-2xl duration-150 md:flex print:hidden"
        >
          {panelHeader(peekArea, false)}
          <nav aria-label={peekArea.title} className="flex-1 overflow-y-auto px-3 pb-3">
            {panelBody(peekArea)}
          </nav>
        </aside>
      )}
    </>
  );
}
