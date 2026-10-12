import { typeFilterForCategory, type NotificationCategory } from "@/lib/notify/events";

export type CentreStatus = "all" | "unread" | "snoozed";

/** The slice of a PostgREST filter builder these filters need (so the same code runs in the page and in tests). */
type Filterable<T> = {
  or(filters: string): T;
  gt(column: string, value: string): T;
  is(column: string, value: null): T;
  neq(column: string, value: string): T;
  not(column: string, operator: string, value: string): T;
};

const OTHER_CATEGORIES: NotificationCategory[] = ["inbox", "work", "escalation", "security"];

/**
 * Applies the notification centre's status and category filters.
 *   all      everything that is not snoozed into the future
 *   unread   the same, unread only
 *   snoozed  only what is snoozed into the future
 * "System" means "none of the other categories".
 */
export function applyCentreFilters<T extends Filterable<T>>(
  q: T,
  opts: { status: CentreStatus; category: NotificationCategory | null; nowIso: string },
): T {
  let out = q;
  if (opts.status === "snoozed") out = out.gt("snoozed_until", opts.nowIso);
  else out = out.or(`snoozed_until.is.null,snoozed_until.lte.${opts.nowIso}`);
  if (opts.status === "unread") out = out.is("read_at", null);

  if (opts.category) {
    const f = typeFilterForCategory(opts.category);
    const parts = [
      ...f.exact.map((t) => `type.eq.${t}`),
      ...f.prefixes.map((p) => `type.like.${p}*`),
    ];
    if (parts.length) out = out.or(parts.join(","));
    else {
      for (const other of OTHER_CATEGORIES) {
        const o = typeFilterForCategory(other);
        for (const t of o.exact) out = out.neq("type", t);
        for (const p of o.prefixes) out = out.not("type", "like", `${p}*`);
      }
    }
  }
  return out;
}
