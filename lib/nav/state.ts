/**
 * Which sidebar modules are expanded and which sections and groups are minimised, per person, in a cookie the server
 * reads so the first paint is right (no database query). Pure: parse, serialise and the transitions.
 *
 * Keys: `m<href>` a module (open or closed, both remembered; absent = open only while you are inside it),
 * `s<href>><section>` a section inside a module and `g<group>` a sidebar group (absent = open; only "minimised" is
 * stored). Unknown or malformed entries are ignored, so a renamed page or section simply falls back to the default.
 */

export const NAV_STATE_COOKIE = "pulse_nav";

export type NavState = Readonly<Record<string, boolean>>;

const MAX_ENTRIES = 80;
const MAX_KEY = 120;
const MAX_ENCODED = 3000;
const KEY = /^[msg][^|]+$/;

export const moduleKey = (href: string) => `m${href}`;
export const sectionStateKey = (sectionKey: string) => `s${sectionKey}`;
export const groupKey = (group: string) => `g${group}`;

export function parseNavState(raw: string | undefined | null): NavState {
  if (!raw || raw.length > MAX_ENCODED) return {};
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const part of text.split("|").slice(-MAX_ENTRIES)) {
    const flag = part[0];
    const key = part.slice(1);
    if ((flag !== "0" && flag !== "1") || key.length > MAX_KEY || !KEY.test(key)) continue;
    delete out[key];
    out[key] = flag === "1";
  }
  return out;
}

export function serializeNavState(state: NavState): string {
  let parts = Object.entries(state)
    .filter(([k]) => k.length <= MAX_KEY && KEY.test(k))
    .map(([k, v]) => `${v ? "1" : "0"}${k}`)
    .slice(-MAX_ENTRIES);
  let encoded = encodeURIComponent(parts.join("|"));
  while (encoded.length > MAX_ENCODED && parts.length > 0) {
    parts = parts.slice(1); // the oldest choices go first
    encoded = encodeURIComponent(parts.join("|"));
  }
  return encoded;
}

/** The full `document.cookie` assignment (one year, whole site, like the collapsed-rail cookie). */
export function navStateCookie(state: NavState): string {
  return `${NAV_STATE_COOKIE}=${serializeNavState(state)}; path=/; max-age=31536000; samesite=lax`;
}

export function isOpen(state: NavState, key: string, fallback: boolean): boolean {
  return state[key] ?? fallback;
}

/** Record a choice; the newest goes last so a full cookie forgets the oldest. Open sections and groups are the default. */
export function setOpen(state: NavState, key: string, open: boolean): NavState {
  const next: Record<string, boolean> = { ...state };
  delete next[key];
  if (key.startsWith("m") || !open) next[key] = open;
  return next;
}

/**
 * Entering a module, section or group opens it again if it was closed earlier: the "closed" choice is forgotten, so a
 * module goes back to its default (open while you are inside it).
 */
export function revealActive(
  state: NavState,
  trail: { module?: string; section?: string; group?: string },
): NavState {
  const keys = [
    trail.group && groupKey(trail.group),
    trail.module && moduleKey(trail.module),
    trail.section && sectionStateKey(trail.section),
  ].filter((k): k is string => !!k && state[k] === false);
  if (keys.length === 0) return state;
  const next: Record<string, boolean> = { ...state };
  for (const k of keys) delete next[k];
  return next;
}

/** Expand all: every module open, every section and group shown. */
export function expandAll(state: NavState, modules: readonly string[]): NavState {
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(state)) if (k.startsWith("m")) next[k] = v;
  for (const m of modules) next[moduleKey(m)] = true;
  return next;
}

/** Collapse all: every module closed; sections and groups keep their own setting. */
export function collapseAll(state: NavState, modules: readonly string[]): NavState {
  let next = state;
  for (const m of modules) next = setOpen(next, moduleKey(m), false);
  return next;
}

export function sameState(a: NavState, b: NavState): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
