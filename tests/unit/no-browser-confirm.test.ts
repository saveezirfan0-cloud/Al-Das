import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { confirmPartsFromText } from "@/lib/shell/confirm-text";

/**
 * Phase D: confirmations use the in-app dialog (`useConfirm()` / `ConfirmDialog` in components/shell/confirm-dialog.tsx),
 * never the browser's `confirm()`, which cannot be styled, translated or tested and blocks the page.
 *
 * ALLOWED is empty: Phases E and F removed the last browser confirms. Do not add to it.
 */
const ALLOWED: readonly string[] = [];

const ROOTS = ["app", "components"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * A browser confirm: `window.confirm(`, `globalThis.confirm(`, `self.confirm(`, or a bare `confirm(` call. The dialog's
 * own calls are awaited (`await confirm(`) and a local helper is a declaration (`function confirm(`); neither counts.
 */
const BROWSER_CONFIRM =
  /(\b(window|globalThis|self)\.confirm\s*\()|((?<![\w$.]|function\s|await\s)confirm\s*\((?!\{))/;

export function browserConfirmLines(src: string): number[] {
  const hits: number[] = [];
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    if (BROWSER_CONFIRM.test(code)) hits.push(i + 1);
  });
  return hits;
}

describe("no browser confirm()", () => {
  it("finds the patterns it is meant to find", () => {
    expect(browserConfirmLines('if (!window.confirm("Delete?")) return;')).toEqual([1]);
    expect(browserConfirmLines('onClick={() => confirm("Delete?") && run()}')).toEqual([1]);
    expect(browserConfirmLines("if (!confirm(`Remove ${x}?`)) return;")).toEqual([1]);
    expect(browserConfirmLines('if (!(await confirm("Delete?"))) return;')).toEqual([]);
    expect(browserConfirmLines('if (!(await ask("Delete?"))) return;')).toEqual([]);
    expect(browserConfirmLines('await confirm({ title: "Delete?" })')).toEqual([]);
    expect(browserConfirmLines("function confirm() {")).toEqual([]);
    expect(browserConfirmLines("// never use confirm() here")).toEqual([]);
    expect(browserConfirmLines("onConfirm()")).toEqual([]);
  });

  it("is not used in app/ or components/ outside the allow-list", () => {
    const offenders: string[] = [];
    for (const root of ROOTS)
      for (const f of files(join(process.cwd(), root))) {
        const rel = relative(process.cwd(), f).split("\\").join("/");
        if (ALLOWED.some((a) => rel.startsWith(a))) continue;
        for (const line of browserConfirmLines(readFileSync(f, "utf8")))
          offenders.push(`${rel}:${line}`);
      }
    expect(offenders).toEqual([]);
  });
});

describe("confirmPartsFromText", () => {
  it("makes the question the title and the rest the description", () => {
    expect(confirmPartsFromText("Delete this file for everyone? This cannot be undone.")).toEqual({
      title: "Delete this file for everyone?",
      description: "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
  });

  it("names the button after the action, destructive only when it removes or stops something", () => {
    expect(confirmPartsFromText("Send this template to Meta for review?")).toMatchObject({
      confirmLabel: "Send",
      destructive: false,
    });
    expect(confirmPartsFromText("Stop new patient document uploads?")).toMatchObject({
      confirmLabel: "Stop",
      destructive: true,
    });
    expect(confirmPartsFromText("Remove Layla Demo-07 from the workspace?").confirmLabel).toBe(
      "Remove",
    );
    expect(confirmPartsFromText("I have read every message.").confirmLabel).toBe("Continue");
  });

  it("never shows two buttons that read the same", () => {
    const p = confirmPartsFromText("Cancel this campaign? Recipients not reached are skipped.");
    expect(p.confirmLabel).toBe("Yes, cancel");
    expect(p.cancelLabel).toBe("Keep it");
  });

  it("keeps a sentence with a dotted name whole and falls back to Continue", () => {
    expect(confirmPartsFromText('Delete "Report v1.2"?').title).toBe('Delete "Report v1.2"?');
    expect(confirmPartsFromText("This cannot be undone.").confirmLabel).toBe("Continue");
    expect(confirmPartsFromText("").title).toBe("Are you sure?");
  });
});
