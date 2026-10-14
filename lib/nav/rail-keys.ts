/**
 * Keyboard rules for the desktop rail and its flyouts (components/shell/app-nav.tsx). Pure, so the decisions are
 * unit-tested; the component only moves focus.
 *
 * A rail area with pages is a disclosure button: Enter, Space or Right arrow opens its pages and moves focus to the
 * first link. Inside the pages, Escape or Left arrow goes back to the area's button, Up and Down arrows (and Home, End)
 * move between the controls, and in a flyout Tab past the last control (or Shift+Tab before the first) leaves it,
 * closing it, so the flyout sits in the tab order right after its own button.
 */

export type KeyLike = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

const modified = (e: KeyLike) => !!(e.ctrlKey || e.altKey || e.metaKey);

/** What a key press on a rail area does: "open" its pages, or nothing (the browser's default). */
export function railKeyAction(e: KeyLike, hasPages: boolean): "open" | null {
  if (!hasPages || modified(e)) return null;
  return e.key === "Enter" || e.key === " " || e.key === "ArrowRight" ? "open" : null;
}

export type PanelKeyAction =
  /** Close a flyout and put focus back on the area's rail button. */
  | { kind: "back" }
  /** Close a flyout and move focus to whatever comes after the area's rail button. */
  | { kind: "next" }
  /** Move focus to the control at this index. */
  | { kind: "focus"; index: number };

/**
 * What a key press inside an area's pages does. `index` is the focused control among the panel's `count` focusable
 * controls (-1 when focus is elsewhere in the panel); `flyout` is true for the pop-out, false for the docked panel, which
 * keeps the browser's own Tab order.
 */
export function panelKeyAction(
  e: KeyLike,
  index: number,
  count: number,
  flyout: boolean,
): PanelKeyAction | null {
  if (modified(e)) return null;
  switch (e.key) {
    case "Escape":
    case "ArrowLeft":
      return { kind: "back" };
    case "Tab":
      if (!flyout || count === 0) return null;
      if (!e.shiftKey && index === count - 1) return { kind: "next" };
      if (e.shiftKey && index <= 0) return { kind: "back" };
      return null;
    case "ArrowDown":
      return count > 0 ? { kind: "focus", index: index < 0 ? 0 : (index + 1) % count } : null;
    case "ArrowUp":
      return count > 0 ? { kind: "focus", index: index <= 0 ? count - 1 : index - 1 } : null;
    case "Home":
      return count > 0 ? { kind: "focus", index: 0 } : null;
    case "End":
      return count > 0 ? { kind: "focus", index: count - 1 } : null;
    default:
      return null;
  }
}
