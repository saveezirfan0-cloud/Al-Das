import { describe, expect, it } from "vitest";

import { parseThemePref, resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

describe("parseThemePref", () => {
  it("accepts the three choices and falls back to light", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("system")).toBe("system");
    for (const raw of [null, undefined, "", "DARK", "blue", 1, {}]) {
      expect(parseThemePref(raw)).toBe("light");
    }
  });
});

describe("resolveTheme", () => {
  it("follows the OS only for system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("THEME_INIT_SCRIPT", () => {
  // The server renders <html> without the class; start "dark" to prove light really removes it.
  function run(stored: string | null, osDark: boolean, storageThrows = false, initial = ["dark"]) {
    const classes = new Set<string>(initial);
    const document = {
      documentElement: {
        classList: {
          toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
        },
      },
    };
    const localStorage = {
      getItem: (key: string) => {
        if (storageThrows) throw new Error("blocked");
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const matchMedia = () => ({ matches: osDark });
    new Function("document", "localStorage", "matchMedia", THEME_INIT_SCRIPT)(
      document,
      localStorage,
      matchMedia,
    );
    return classes.has("dark");
  }

  it("applies the stored choice before paint", () => {
    expect(run("light", true)).toBe(false);
    expect(run(null, true)).toBe(false);
    expect(run("dark", false)).toBe(true);
    expect(run("system", true)).toBe(true);
    expect(run("system", false)).toBe(false);
  });

  it("never throws when storage is blocked and leaves the page light", () => {
    expect(() => run("dark", true, true, [])).not.toThrow();
    expect(run("dark", true, true, [])).toBe(false);
  });
});
