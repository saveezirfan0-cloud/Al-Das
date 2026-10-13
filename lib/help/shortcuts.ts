/** Keyboard shortcuts shown in the cheat sheet (press ?). Keep in step with the handlers that implement them. */
export type ShortcutGroup = {
  title: string;
  items: ReadonlyArray<{ keys: readonly string[]; does: string }>;
};

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { keys: ["?"], does: "Show this list" },
      { keys: ["Ctrl", "K"], does: "Quick search: jump to any page, Finance page or setting" },
      { keys: ["Esc"], does: "Close a panel or dialog" },
    ],
  },
  {
    title: "In the inbox composer",
    items: [
      { keys: ["/"], does: "Open your quick replies; keep typing to narrow them" },
      { keys: ["Enter"], does: "Send the message (or pick the only matching quick reply)" },
      { keys: ["Shift", "Enter"], does: "New line" },
    ],
  },
  {
    title: "On the Front desk",
    items: [
      { keys: ["/"], does: "Focus the patient search box" },
      { keys: ["N"], does: "Register a walk-in" },
      { keys: ["R"], does: "Refresh the board" },
    ],
  },
];

/** True when the key press happened while the person was typing, so a bare-key shortcut must not fire. */
export function isTypingTarget(
  el: {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  } | null,
): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

/** "?" is Shift + / on most keyboards; accept either spelling but never with Ctrl, Alt or Meta held. */
export function isHelpKey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  return e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey;
}
