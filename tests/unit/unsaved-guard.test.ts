import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DISCARD_QUESTION, isDirty, sameValues } from "@/lib/shell/unsaved";

describe("unsaved changes", () => {
  it("compares plain form values deeply", () => {
    expect(
      sameValues({ a: "x", b: [1, 2], c: { d: null } }, { a: "x", b: [1, 2], c: { d: null } }),
    ).toBe(true);
    expect(sameValues({ a: "x" }, { a: "y" })).toBe(false);
    expect(sameValues({ a: "x" }, { a: "x", b: "" })).toBe(false);
    expect(sameValues([1, 2], [2, 1])).toBe(false);
    expect(sameValues([], {})).toBe(false);
    expect(sameValues(null, {})).toBe(false);
  });

  it("is dirty only once something moved away from what was loaded", () => {
    const loaded = { full_name: "Layla Demo-07", job_title: "" };
    expect(isDirty(loaded, null)).toBe(false);
    expect(isDirty({ ...loaded }, loaded)).toBe(false);
    expect(isDirty({ ...loaded, job_title: "Nurse" }, loaded)).toBe(true);
  });

  it("asks before discarding, with buttons that cannot be confused", () => {
    expect(DISCARD_QUESTION.confirmLabel).toBe("Discard");
    expect(DISCARD_QUESTION.cancelLabel).toBe("Keep editing");
    expect(DISCARD_QUESTION.destructive).toBe(true);
  });

  it("is used by the Staff and Doctors drawers, with the browser prompt on reload", () => {
    for (const f of [
      "app/(app)/staff/staff-drawer.tsx",
      "app/(app)/doctors/doctors-workspace.tsx",
    ]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toContain("<DrawerFooter");
      expect(src, f).toContain("useUnsavedGuard(dirty)");
      expect(src, f).toContain("{guardDialog}");
      expect(src, f).toContain("onOpenChange={(o) => !o && void close()}");
    }
    const hook = readFileSync(join(process.cwd(), "components/shell/drawer-footer.tsx"), "utf8");
    expect(hook).toContain('addEventListener("beforeunload"');
    expect(hook).toContain('removeEventListener("beforeunload"');
  });
});
