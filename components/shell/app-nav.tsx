"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { panelKeyAction, railKeyAction } from "@/lib/nav/rail-keys";
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

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab can reach inside `root`, in document order (hidden ones skipped). */
function tabbables(root: ParentNode | null | undefined): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/** Focuses the first page link in a panel (or its first control when every section is folded). */
function focusFirstLink(panel: HTMLElement | null) {
  if (!panel) return;
  (panel.querySelector<HTMLElement>("nav a[href]") ?? tabbables(panel)[0])?.focus();
}

/** Focuses what Tab would reach after `trigger` if `skip` (the flyout) were not there; the trigger itself at the end. */
function focusAfter(trigger: HTMLElement, skip: HTMLElement) {
  const all = tabbables(document).filter((el) => !skip.contains(el));
  (all[all.indexOf(trigger) + 1] ?? trigger).focus();
}

/**
 * Desktop navigation: a slim rail with one icon per area. Pointing at an area pops its pages out in a flyout; the pin
 * in the flyout docks that area's panel beside the rail, and the pin in the docked panel undocks it. Module sections
 * fold away. An area with a single page (Home) is a link with a tooltip.
 *
 * Keyboard (lib/nav/rail-keys.ts): an area with pages is a disclosure button. Enter, Space or Right arrow opens its
 * pages and focuses the first link; Escape or Left arrow returns to the button; Tab past the last control closes the
 * flyout and moves on to the next area. A pointer click on the button still opens the area's first page. The phone
 * drawer keeps the full tree (sidebar.tsx).
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
  const search = useSearchParams();
  const router = useRouter();
  const tree = useBadgedItems(rawTree);
  const counts = useNavBadges();
  const uid = useId();

  const trail = useMemo(() => activeTrail(tree, pathname, search), [tree, pathname, search]);
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

  // Keyboard: the rail buttons by area, the two panels, and a request to focus the flyout's first link once it renders.
  const triggers = useRef(new Map<string, HTMLElement>());
  const flyoutRef = useRef<HTMLElement>(null);
  const dockedRef = useRef<HTMLElement>(null);
  const focusOnOpen = useRef(false);
  const flyoutId = `${uid}-flyout`;
  const dockedId = `${uid}-docked`;
  /** The area whose name shows as a tooltip because its button has keyboard focus (pointing shows the flyout). */
  const [hint, setHint] = useState<string | null>(null);

  function openFromKeyboard(a: Area) {
    clearTimeout(timer.current);
    setHint(null);
    if (docked && a.key === area?.key) {
      focusFirstLink(dockedRef.current);
      return;
    }
    if (peekKey === a.key) {
      focusFirstLink(flyoutRef.current);
      return;
    }
    focusOnOpen.current = true;
    setPeekKey(a.key);
  }
  useEffect(() => {
    if (!peekKey || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    focusFirstLink(flyoutRef.current);
  }, [peekKey]);

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLElement>, a: Area, flyout: boolean) {
    const items = tabbables(e.currentTarget);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const act = panelKeyAction(e, index, items.length, flyout);
    if (!act) return;
    if (act.kind === "focus") {
      e.preventDefault();
      items[act.index]?.focus();
      return;
    }
    const trigger = triggers.current.get(a.key);
    if (!trigger) return;
    e.preventDefault();
    if (flyout) {
      clearTimeout(timer.current);
      setPeekKey(null);
    }
    if (act.kind === "back") trigger.focus();
    else focusAfter(trigger, e.currentTarget);
  }
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
    const dockedHere = docked && active;
    const expanded = flyout && (peekKey === a.key || dockedHere);
    const waiting = areaCount(a);
    const countId = `${uid}-${a.key}-count`;
    const itemClass =
      "group/item relative flex w-full justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/80";
    const inner = (
      <>
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
          {waiting > 0 && (
            // the rail is dark in both themes: red-400 keeps 4.9:1 against the rail-coloured ring (destructive is 2.4:1)
            <span
              className="ring-rail absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-red-400 ring-2"
              aria-hidden
            />
          )}
        </span>
      </>
    );
    const tip = (
      <TooltipContent side="right" className="flex flex-col items-start gap-0">
        <span className="font-medium">{a.title}</span>
        {a.subtitle && <span className="opacity-75">{a.subtitle}</span>}
      </TooltipContent>
    );
    const count =
      waiting > 0 ? (
        <span id={countId} className="sr-only">
          {waiting} waiting
        </span>
      ) : null;
    if (!flyout)
      return (
        <li key={a.key}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={a.href}
                aria-label={a.title}
                aria-describedby={count ? countId : undefined}
                aria-current={active ? "page" : undefined}
                onMouseEnter={() => openPeek(a)}
                onFocus={() => openPeek(a)}
                className={itemClass}
              >
                {inner}
              </Link>
            </TooltipTrigger>
            {tip}
          </Tooltip>
          {count}
        </li>
      );
    return (
      <li key={a.key}>
        {/* The name shows as a tooltip only while the button has keyboard focus; pointing opens the flyout instead. */}
        <Tooltip open={hint === a.key && !expanded}>
          <TooltipTrigger asChild>
            <button
              type="button"
              ref={(el) => {
                if (el) triggers.current.set(a.key, el);
                else triggers.current.delete(a.key);
              }}
              aria-label={a.title}
              aria-describedby={count ? countId : undefined}
              aria-current={active ? "true" : undefined}
              aria-expanded={expanded}
              aria-controls={expanded ? (dockedHere ? dockedId : flyoutId) : undefined}
              onMouseEnter={() => {
                router.prefetch(a.href);
                openPeek(a);
              }}
              onMouseLeave={() => closePeek()}
              onFocus={(e) => {
                if (e.currentTarget.matches(":focus-visible")) setHint(a.key);
              }}
              onBlur={() => setHint((h) => (h === a.key ? null : h))}
              onKeyDown={(e) => {
                if (railKeyAction(e, true) !== "open") return;
                e.preventDefault();
                openFromKeyboard(a);
              }}
              onClick={(e) => {
                // detail 0: activated without a pointer (a screen reader's click): open the pages like Enter
                if (e.detail === 0) return openFromKeyboard(a);
                clearTimeout(timer.current);
                setPeekKey(null);
                router.push(a.href);
              }}
              className={itemClass}
            >
              {inner}
            </button>
          </TooltipTrigger>
          {tip}
        </Tooltip>
        {count}
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
          id={dockedId}
          ref={dockedRef}
          aria-label={`${area.title} pages`}
          onKeyDown={(e) => onPanelKeyDown(e, area, false)}
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
          id={flyoutId}
          ref={flyoutRef}
          aria-label={`${peekArea.title} pages`}
          onKeyDown={(e) => onPanelKeyDown(e, peekArea, true)}
          onMouseEnter={keepPeek}
          onMouseLeave={() => closePeek()}
          onFocus={keepPeek}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closePeek(0);
          }}
          className="bg-sidebar text-sidebar-foreground border-sidebar-border animate-in fade-in slide-in-from-left-2 motion-reduce:animate-none fixed inset-y-0 left-[4.5rem] z-40 hidden w-64 flex-col border-r shadow-2xl duration-150 md:flex print:hidden"
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
