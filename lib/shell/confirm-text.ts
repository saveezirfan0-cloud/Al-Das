/**
 * Turns a one-line question ("Delete this file? This cannot be undone.") into the in-app confirmation's parts: the
 * question as the title, the rest as the description, and the button named after the action ("Delete") in the
 * destructive style when the action removes or stops something. Pure, so the wording rules are unit-tested.
 */
export type ConfirmParts = {
  title: string;
  description?: string;
  confirmLabel: string;
  /** Set when the action itself is "Cancel ...", so the two buttons never read the same. */
  cancelLabel?: string;
  destructive: boolean;
};

const DESTRUCTIVE =
  /^(delete|remove|revoke|cancel|stop|rotate|unlink|discard|archive|erase|disconnect|reset|replace|unpublish|withdraw|reject)\b/i;

export function confirmPartsFromText(text: string): ConfirmParts {
  const clean = text.replace(/\s+/g, " ").trim();
  // the first question (or sentence) is the title; anything after it explains the consequence
  const m = /^(.+?[?.!])(\s+(.+))?$/.exec(clean);
  const title = (m ? m[1] : clean) || "Are you sure?";
  const description = m?.[3]?.trim() || undefined;
  const verb = /^([A-Za-z-]+)/.exec(title)?.[1] ?? "";
  const destructive = DESTRUCTIVE.test(title);
  const label = verb ? verb[0].toUpperCase() + verb.slice(1).toLowerCase() : "";
  // a question that does not start with a verb ("Send 20 messages now?" does; "This cannot be undone." does not)
  const confirmLabel =
    /^(this|it|are|is|do|you|the|there|i|we|my|our|your)$/i.test(label) || !label
      ? "Continue"
      : label;
  if (confirmLabel === "Cancel")
    return { title, description, confirmLabel: "Yes, cancel", cancelLabel: "Keep it", destructive };
  return { title, description, confirmLabel, destructive };
}
