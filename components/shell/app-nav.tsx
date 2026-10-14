"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Activity, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
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

import { NAV_GROUPS, SIDEBAR_COOKIE } from "./nav";
import { useNavBadges } from "./nav-badges";
import { useBadgedItems } from "./shell-data";
import { CountPill, ICONS, type SidebarNode } from "./sidebar";

/**
 * Desktop navigation: a slim icon rail for every area (it widens over the page to show names while you point at it or
 * tab through it), and beside it a pages panel for the area you are in when that area has sub-pages (Finance,
 * Accounting, Settings). Pages without sub-pages get the full width. The phone drawer keeps the full tree (sidebar.tsx).
 */
export function AppNav({
  tree: rawTree,
  orgName,
  navState,
  defaultPanelHidden,
}: {
  tree: readonly SidebarNode[];
  orgName: string;
  /** Minimised sections, read from the cookie by the server layout. */
  navState: NavState;
  defaultPanelHidden: boolean;
}) {
  const pathname = usePathname();
  const tree = useBadgedItems(rawTree);
  const counts = useNavBadges();
  const uid = useId();

  const trail = useMemo(() => activeTrail(tree, pathname), [tree, pathname]);
  const area = tree.find((n) => n.href === trail.module && n.sections);

  const [panelHidden, setPanelHidden] = useState(defaultPanelHidden);
  const [nav, setNav] = useState<NavState>(() => revealActive(navState, trail));
  useEffect(() => {
    setNav((s) => revealActive(s, trail));
    // only when you move into another area or section
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

  // Keep the current area's icon in view when the rail scrolls (short screens).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [trail.item]);

  function togglePanel() {
    const next = !panelHidden;
    setPanelHidden(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  const moduleTotal = (node: SidebarNode) =>
    (node.sections ?? []).reduce(
      (sum, s) => sum + s.pages.reduce((x, p) => x + (counts[p.href] ?? 0), 0),
      0,
    );

  function railItem(item: SidebarNode) {
    const Icon = ICONS[item.icon];
    const active = trail.item === item.href;
    const count = item.sections ? moduleTotal(item) : (item.badge ?? 0);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active && !trail.page ? "page" : undefined}
          data-active={active}
          className="group/item relative flex h-10 items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          {active && (
            <span
              className="bg-brand-accent absolute top-2 -left-3 h-6 w-1 rounded-r-full"
              aria-hidden
            />
          )}
          <span
            className={cn(
              "relative flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors",
              active
                ? "bg-rail-active text-rail-active-foreground shadow-sm"
                : "bg-rail-muted text-rail-foreground group-hover/item:bg-rail-hover",
            )}
          >
            <Icon className="size-[18px]" aria-hidden />
            {count > 0 && (
              <span
                className="bg-destructive ring-rail absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2"
                aria-hidden
              />
            )}
          </span>
          <span className="text-rail-foreground min-w-0 flex-1 truncate text-sm font-medium opacity-0 transition-opacity group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100">
            {item.label}
          </span>
          {count > 0 && (
            <span className="pr-2 opacity-0 transition-opacity group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100">
              <CountPill n={count} label={item.sections ? "waiting" : "overdue"} />
            </span>
          )}
        </Link>
      </li>
    );
  }

  const top = tree.filter((i) => !i.group && i.icon !== "settings");
  const bottom = tree.filter((i) => !i.group && i.icon === "settings");
  const ModuleIcon = area ? ICONS[area.icon] : null;

  return (
    <>
      {/* The rail keeps its 4rem in the layout; the nav inside widens over the page instead of pushing it. */}
      <div className="relative hidden w-16 shrink-0 md:block print:hidden">
        <nav
          aria-label="Main"
          className="group/rail bg-rail absolute inset-y-0 left-0 z-40 flex w-16 flex-col overflow-hidden transition-[width,box-shadow] duration-200 hover:w-60 hover:shadow-2xl hover:delay-150 has-[:focus-visible]:w-60 has-[:focus-visible]:shadow-2xl"
        >
          <Link
            href="/dashboard"
            className="flex h-14 shrink-0 items-center gap-3 px-3 outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-inset"
          >
            <span className="bg-brand-accent text-rail-active-foreground flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm">
              <Activity className="size-5" aria-hidden />
            </span>
            <span className="min-w-0 opacity-0 transition-opacity group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100">
              <span className="text-rail-foreground block truncate text-sm font-semibold">
                Pulse
              </span>
              <span className="text-rail-foreground/70 block truncate text-xs">{orgName}</span>
            </span>
          </Link>
          <div className="bg-rail-foreground/10 mx-3 h-px shrink-0" aria-hidden />

          <div
            ref={scrollRef}
            className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 [scrollbar-width:none]"
          >
            <ul className="flex flex-col gap-1">{top.map(railItem)}</ul>
            {NAV_GROUPS.map((group) => {
              const items = tree.filter((i) => i.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} role="group" aria-label={group}>
                  <div className="flex h-5 items-center" aria-hidden>
                    <span className="bg-rail-foreground/10 h-px w-10 shrink-0 group-hover/rail:hidden group-has-[:focus-visible]/rail:hidden" />
                    <span className="text-rail-foreground/60 hidden truncate text-[11px] font-semibold tracking-wide uppercase group-hover/rail:block group-has-[:focus-visible]/rail:block">
                      {group}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1">{items.map(railItem)}</ul>
                </div>
              );
            })}
          </div>

          <div className="border-rail-foreground/10 flex shrink-0 flex-col gap-1 border-t px-3 py-2">
            <ul className="flex flex-col gap-1">{bottom.map(railItem)}</ul>
            {area && panelHidden && (
              <button
                type="button"
                onClick={togglePanel}
                className="group/item flex h-10 items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              >
                <span className="bg-rail-muted text-rail-foreground group-hover/item:bg-rail-hover flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <PanelLeftOpen className="size-[18px]" aria-hidden />
                </span>
                <span className="text-rail-foreground truncate text-sm font-medium opacity-0 transition-opacity group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100">
                  Show {area.label} menu
                </span>
              </button>
            )}
          </div>
        </nav>
      </div>

      {area && ModuleIcon && !panelHidden && (
        <aside
          aria-label={`${area.label} pages`}
          className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-60 shrink-0 flex-col border-r md:flex print:hidden"
        >
          <div className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <ModuleIcon className="size-[18px]" aria-hidden />
            </span>
            <Link
              href={area.href}
              className="min-w-0 flex-1 truncate font-semibold outline-none hover:underline focus-visible:underline"
            >
              {area.label}
            </Link>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={togglePanel}
              aria-label={`Hide ${area.label} menu`}
              className="text-muted-foreground"
            >
              <PanelLeftClose aria-hidden />
            </Button>
          </div>
          <nav aria-label={area.label} className="flex-1 overflow-y-auto p-2">
            {area.sections!.map((s, j) => {
              const sOpen = isOpen(nav, sectionStateKey(s.key), true);
              const sid = `${uid}-s${j}`;
              const waiting = s.pages.reduce((x, p) => x + (counts[p.href] ?? 0), 0);
              return (
                <div key={s.key} className="mb-1">
                  <button
                    type="button"
                    data-slot="nav-toggle"
                    aria-expanded={sOpen}
                    aria-controls={sid}
                    onClick={() => setNav((st) => setOpen(st, sectionStateKey(s.key), !sOpen))}
                    className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2 pt-3 pb-1.5 text-left text-[11px] font-semibold tracking-wide uppercase"
                  >
                    <ChevronRight
                      className={cn("size-3.5 shrink-0 transition-transform", sOpen && "rotate-90")}
                      aria-hidden
                    />
                    <span className="truncate">{s.title}</span>
                    {!sOpen && waiting > 0 ? (
                      <span className="bg-destructive ml-auto size-1.5 rounded-full" aria-hidden />
                    ) : null}
                  </button>
                  {sOpen && (
                    <ul id={sid} className="flex flex-col gap-0.5">
                      {s.pages.map((p) => {
                        const active = trail.page === p.href;
                        const n = counts[p.href] ?? 0;
                        return (
                          <li key={p.href}>
                            <Link
                              href={p.href}
                              aria-current={active ? "page" : undefined}
                              className={cn(
                                "relative flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors outline-none",
                                "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-2",
                                active &&
                                  "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                              )}
                            >
                              {active && (
                                <span
                                  className="bg-sidebar-primary absolute inset-y-2 left-0 w-[3px] rounded-r-full"
                                  aria-hidden
                                />
                              )}
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
          </nav>
        </aside>
      )}
    </>
  );
}
