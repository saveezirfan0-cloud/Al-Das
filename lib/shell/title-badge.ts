/** Browser-tab badge: "(3) Inbox · Pulse". Pure so it can be unit-tested. */

const BADGE = /^\(\d+\+?\)\s+/;

export function stripBadge(title: string): string {
  return title.replace(BADGE, "");
}

export function withBadge(title: string, count: number): string {
  const base = stripBadge(title);
  if (!Number.isFinite(count) || count <= 0) return base;
  return `(${count > 99 ? "99+" : count}) ${base}`;
}
