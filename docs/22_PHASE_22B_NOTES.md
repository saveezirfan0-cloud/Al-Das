# Phase 22B notes: ERP-style navigation

Slice 22B of `docs/22_ACCOUNTING_PLAN.md` §5. Built in a cloud worktree on top of `6abe2f6` (the accounting plan commit). The sidebar becomes a tree: modules (Finance, Settings, and Accounting once 22A lands) expand to their sections and pages, every level can be minimised, the choice is remembered per person in a cookie, the collapsed rail opens a flyout per module, and Ctrl K finds every module page.

## What changed

| Piece | Where | What it does |
|---|---|---|
| Module registry | `lib/nav/modules.ts` | `NAV_MODULES` maps a top-level sidebar href to that module's own page list (`href, label, section, permissions` or `allow`, optional `keywords`, `badge`). Finance registers `FINANCE_NAV`, Settings registers `SETTINGS_PAGES`. The lists are the same ones the in-page menus, the Finance landing redirect and the tests already use, so they cannot drift |
| Tree builder (pure) | `lib/nav/tree.ts` | `buildNavTree(items, modules, member)` filters top-level items (moved here from the app layout) and each module's pages by permission, groups pages into sections in first-seen order, drops empty sections and a module with no visible page, and returns plain data (no functions) for the client. `activeTrail(tree, path)` finds the item, module, section and longest matching page; `treeKeys()` feeds Expand all / Collapse all |
| Remembered state (pure) | `lib/nav/state.ts` | Cookie `pulse_nav`: `m<href>` module open/closed (absent = open only while you are inside it), `s<href>><section>` and `g<group>` stored only when minimised. Parse ignores garbage, unknown keys and oversized values; serialise keeps the newest 80 choices under 3,000 encoded characters. `revealActive()` forgets a "closed" choice when you move into that module, section or group, so the current page is always visible |
| Sidebar | `components/shell/sidebar.tsx` | Module row: the label goes to the module's landing page (`/finance` still redirects with `financeLanding`), the chevron expands or collapses it. Sections are small sub-headers with their own chevron; the groups (Today, Patients, Growth, Insight & back office) fold too. Expand all / Collapse all sit at the top (Expand all opens every module and shows every section and group; Collapse all closes modules only). Settings moved from the footer into the scrolling list (after the groups) so its tree has room; the footer keeps the rail toggle, which is no longer shown inside the phone drawer |
| Collapsed rail | `ModuleFlyout` in `sidebar.tsx` | A module icon opens a Radix dropdown beside the rail on mouse hover (120 ms in, 200 ms out, the pointer can cross into it) or on press. Keyboard: Enter, Space or Down open and focus the first page, arrows move, Escape closes and returns focus to the icon. Sections are labels, the module's landing page is the first item. Leaf items keep their tooltip |
| First paint | `app/(app)/layout.tsx` | Reads `pulse_nav` with the existing `pulse_sidebar` cookie and passes the parsed state to the sidebar and the phone drawer. **No query was added** (a unit test reads the layout source for `createClient`, `.from(`, `.rpc(` and `loadFinanceBadges`) |
| Badges | `components/shell/nav-badges.tsx`, `app/(app)/finance/layout.tsx` | The Finance layout already fetched its badge counts server-side with the member's own client; it now also publishes them (`<PublishNavBadges>`) into a small client context, and the tree shows them on the pages (a pill on a closed module, a dot on a minimised section and on the rail icon). Leaving Finance clears them. The app layout fetches nothing |
| In-page menus | `app/(app)/settings/settings-nav.tsx` (`mobileOnly`), Finance and Settings layouts | From `md` up the sidebar tree lists the same pages, so the in-page menu is hidden there; phones keep it (the sidebar is a drawer on phones). Portal keeps its in-page menu everywhere (not a registered module) |
| Quick search | `app/(app)/layout.tsx` | Every registered page is a quick link with `<module> · <section>` as its hint (e.g. "Finance · Billing and claims"); Settings pages keep the same hint shape as before and Finance pages are newly findable |
| Touch | `app/globals.css` | `[data-slot="nav-toggle"]` (chevrons, section and group headers, Expand/Collapse all) gets 44 x 44 px on coarse pointers; tree links were already covered by `aside a[href]` |
| Help | `lib/help/whats-new.ts`, `guides.ts` (fallback guide), `shortcuts.ts` (Ctrl K text) | Release note and one guide line. No new keyboard shortcut was added |

## How to register a module (e.g. Accounting)

1. In `lib/nav/modules.ts` add ONE line to `NAV_MODULES` (and its import):
   ```ts
   import { ACCOUNTING_NAV } from "@/lib/accounting/nav";
   "/accounting": ACCOUNTING_NAV,
   ```
   `ACCOUNTING_NAV` entries need `href` (under `/accounting/`), `label`, `section` and `permissions` (visible with ANY), like `FINANCE_NAV`. The top-level item `/accounting` must exist in `NAV_ITEMS` (`components/shell/nav.ts`), with an icon; a unit test checks every registry key is a real item and every page sits under it.
2. In the module's layout pass `mobileOnly` to its `SettingsNav` (the tree replaces it from `md` up).
3. If it has badges, publish them from its layout: `<PublishNavBadges counts={{ "/accounting/approvals": 3 }} />` (counts fetched there, server-side, with the member's client; never in the app layout).

Quick search, the rail flyout, Expand/Collapse all and the remembered state pick the module up with no further change.

## Decisions

- **Explicit vs automatic open.** A module with no stored choice is open only while you are inside it; an explicit open is remembered; an explicit close is forgotten when you next move into that module (so the active page is never hidden). Sections and groups are open unless minimised, and are re-shown the same way.
- **Badges are module-local.** Rather than a browser fetch of every module's counts, the counts the module's layout already loads are shared with the sidebar while you are in it. Outside Finance the tree shows no Finance counts (the old flat sidebar showed none either).
- **Settings left the footer** because a 25-page tree does not fit there. It sits under a divider after the groups.
- **Collapse all closes modules only.** Minimising every group as well would leave four headings and nothing to click.
- **No new libraries.** The flyout reuses the shadcn `DropdownMenu` already in the shell bundle (user menu), so first-load JS barely moves.

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | clean |
| `pnpm audit:security` | 523 entry points, 0 unguarded and unreviewed (no new action or route) |
| Unit tests (`vitest run tests/unit`) | **217 files / 2,912 tests pass**, including the new `tests/unit/nav-tree.test.ts` (17 tests: permission filtering, wildcard and suspended members, `allow()` entries, empty sections and modules dropped, order kept with split sections, plain-data output, registry keys are real items, active trail and longest-page match, cookie round trip, garbage and oversized input, newest-80 cap, defaults, reveal on entry, Expand/Collapse all, and a source check that `app/(app)/layout.tsx` has no `createClient`, `.from(`, `.rpc(` or `loadFinanceBadges`). Existing nav tests (`shell-nav`, `finance/nav`, `help-content`) unchanged and passing. No SQL was touched, so the database suites were not run |
| `pnpm build` + `pnpm bundle:check` | Build passes (no Supabase variables set); **budgets OK, none raised** (e.g. /dashboard 119 kB of 130, /inbox 299 of 315, /finance/summary 116, shared 104). The flyout reuses the dropdown already in the shell bundle |
| Browser (Playwright, `/opt/pw-browsers/chromium`, against `pnpm dev`) | Login cannot be bypassed (`requireMember` needs Supabase Auth), so a **temporary, uncommitted** page rendered the real `Sidebar` with an admin's tree (`buildNavTree(NAV_ITEMS, NAV_MODULES, member(["*"]))`) and two published Finance badges. Seen: the tree with Finance expanded and Growth and Finance Setup minimised; Collapse all (Finance shows the badge total 6 when closed); the chevron writes `pulse_nav`; in the rail, Enter on the Finance icon opens the flyout with focus on the first item, Escape returns focus to the icon, mouse hover opens Settings' flyout; at phone size with touch (Pixel 7 emulation) the 72 tree links and toggles are all at least 44 px |
| Not verified | The real app shell with a signed-in member (topbar drawer, the active-page highlight inside a real Finance page, the Finance layout publishing its real counts), screen readers, Safari/Firefox. Worth a click-through on staging: open a Finance page directly (module and section open, page highlighted), minimise a section, reload (state kept), shrink to the rail and use the flyouts, and on a phone check that the Finance in-page menu is still at the top |
