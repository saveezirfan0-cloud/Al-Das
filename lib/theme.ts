/**
 * Light / Dark / Match-system appearance. The choice is a per-browser convenience kept in localStorage
 * (default Light); the `.dark` class on <html> switches the tokens in app/globals.css.
 */
export type ThemePref = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "pulse-theme";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseThemePref(raw: unknown): ThemePref {
  return raw === "dark" || raw === "system" ? raw : "light";
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): "light" | "dark" {
  return pref === "dark" || (pref === "system" && prefersDark) ? "dark" : "light";
}

/** Runs in <head> before paint so a dark choice never flashes light. Must not throw. */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=p==="dark"||(p==="system"&&matchMedia(${JSON.stringify(DARK_QUERY)}).matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

/** Browser only: remember the choice and apply it now. */
export function applyTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Private mode or blocked storage: still apply for this page.
  }
  const dark = resolveTheme(pref, window.matchMedia(DARK_QUERY).matches) === "dark";
  document.documentElement.classList.toggle("dark", dark);
}
