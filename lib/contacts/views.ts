/**
 * Built-in contact views (Sanoflow parity) expressed as filters.
 */
import { and, cond, emptyFilter, type Filter } from "@/lib/filters/ast";

export const CONTACT_VIEWS = [
  { key: "all", label: "All contacts" },
  { key: "recent7", label: "Last interacted < 7 days" },
  { key: "recent30", label: "Last interacted < 30 days" },
  { key: "stale30", label: "Last interacted > 30 days" },
  { key: "mentions", label: "Mentions" },
] as const;

export type ContactViewKey = (typeof CONTACT_VIEWS)[number]["key"];

export function isContactViewKey(v: string | null | undefined): v is ContactViewKey {
  return CONTACT_VIEWS.some((x) => x.key === v);
}

/** The filter behind a built-in view. `userId` is needed for Mentions. */
export function viewFilter(view: ContactViewKey, userId: string): Filter {
  switch (view) {
    case "recent7":
      return { include: and(cond("last_interaction_at", "within_last", 7)) };
    case "recent30":
      return { include: and(cond("last_interaction_at", "within_last", 30)) };
    case "stale30":
      return { include: and(cond("last_interaction_at", "older_than", 30)) };
    case "mentions":
      return { include: and(cond("mentioned_user", "eq", userId)) };
    default:
      return emptyFilter();
  }
}

/** AND-combines filters, ignoring empties. */
export function combineFilters(...filters: Array<Filter | null | undefined>): Filter {
  const present = filters.filter((f): f is Filter => !!f);
  if (present.length === 0) return emptyFilter();
  if (present.length === 1) return present[0];
  return {
    include: and(...present.map((f) => f.include)),
    exclude: present.some((f) => f.exclude && f.exclude.children.length)
      ? {
          type: "group",
          logic: "or",
          children: present.flatMap((f) => (f.exclude ? [f.exclude] : [])),
        }
      : null,
  };
}
