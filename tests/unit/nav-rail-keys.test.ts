import { describe, expect, it } from "vitest";

import { panelKeyAction, railKeyAction } from "@/lib/nav/rail-keys";

describe("railKeyAction", () => {
  it("opens an area with pages on Enter, Space and Right arrow", () => {
    for (const key of ["Enter", " ", "ArrowRight"])
      expect(railKeyAction({ key }, true), key).toBe("open");
  });

  it("leaves other keys, modified keys and single-page areas to the browser", () => {
    expect(railKeyAction({ key: "Tab" }, true)).toBeNull();
    expect(railKeyAction({ key: "ArrowDown" }, true)).toBeNull();
    expect(railKeyAction({ key: "Enter", ctrlKey: true }, true)).toBeNull();
    expect(railKeyAction({ key: "Enter", metaKey: true }, true)).toBeNull();
    // Home (one page) is a plain link: Enter follows it
    expect(railKeyAction({ key: "Enter" }, false)).toBeNull();
  });
});

describe("panelKeyAction", () => {
  it("goes back to the rail button on Escape and Left arrow, in a flyout or the docked panel", () => {
    for (const flyout of [true, false]) {
      expect(panelKeyAction({ key: "Escape" }, 2, 5, flyout)).toEqual({ kind: "back" });
      expect(panelKeyAction({ key: "ArrowLeft" }, 0, 5, flyout)).toEqual({ kind: "back" });
    }
  });

  it("leaves a flyout when Tab goes past its last control, and returns on Shift+Tab before the first", () => {
    expect(panelKeyAction({ key: "Tab" }, 4, 5, true)).toEqual({ kind: "next" });
    expect(panelKeyAction({ key: "Tab", shiftKey: true }, 0, 5, true)).toEqual({ kind: "back" });
    // inside the flyout, Tab is the browser's
    expect(panelKeyAction({ key: "Tab" }, 2, 5, true)).toBeNull();
    expect(panelKeyAction({ key: "Tab", shiftKey: true }, 3, 5, true)).toBeNull();
  });

  it("keeps the browser's Tab order in the docked panel", () => {
    expect(panelKeyAction({ key: "Tab" }, 4, 5, false)).toBeNull();
    expect(panelKeyAction({ key: "Tab", shiftKey: true }, 0, 5, false)).toBeNull();
  });

  it("moves between controls with the arrows, wrapping, and Home / End", () => {
    expect(panelKeyAction({ key: "ArrowDown" }, 1, 5, true)).toEqual({ kind: "focus", index: 2 });
    expect(panelKeyAction({ key: "ArrowDown" }, 4, 5, true)).toEqual({ kind: "focus", index: 0 });
    expect(panelKeyAction({ key: "ArrowUp" }, 0, 5, true)).toEqual({ kind: "focus", index: 4 });
    expect(panelKeyAction({ key: "ArrowUp" }, 3, 5, false)).toEqual({ kind: "focus", index: 2 });
    expect(panelKeyAction({ key: "ArrowDown" }, -1, 5, true)).toEqual({ kind: "focus", index: 0 });
    expect(panelKeyAction({ key: "Home" }, 3, 5, true)).toEqual({ kind: "focus", index: 0 });
    expect(panelKeyAction({ key: "End" }, 0, 5, true)).toEqual({ kind: "focus", index: 4 });
  });

  it("does nothing for an empty panel, other keys or modified keys", () => {
    expect(panelKeyAction({ key: "ArrowDown" }, -1, 0, true)).toBeNull();
    expect(panelKeyAction({ key: "Tab" }, -1, 0, true)).toBeNull();
    expect(panelKeyAction({ key: "a" }, 1, 5, true)).toBeNull();
    expect(panelKeyAction({ key: "Escape", altKey: true }, 1, 5, true)).toBeNull();
  });
});
