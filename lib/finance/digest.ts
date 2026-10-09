import { holds, isOverdue, ownerPermission, RULE_INFO } from "@/lib/finance/rules";

/**
 * Daily exception digest: one e-mail per member listing the open and overdue exceptions they can
 * see. Pure. Counts and rule names only, never an invoice number, claim number or patient detail.
 */

export type OpenException = {
  rule_code: string;
  owner_role: string;
  due_date: string | null;
  status: string;
};
export type DigestMember = {
  userId: string;
  email: string;
  firstName?: string | null;
  permissions: readonly string[];
};
export type DigestEmail = { to: string; subject: string; text: string };

export function buildDigests(
  exceptions: readonly OpenException[],
  members: readonly DigestMember[],
  appUrl: string,
  today = new Date(),
): DigestEmail[] {
  const out: DigestEmail[] = [];
  for (const m of members) {
    if (!m.email || !holds(m.permissions, "finance.exceptions.manage")) continue;
    const mine = exceptions.filter((e) => holds(m.permissions, ownerPermission(e.owner_role)));
    if (mine.length === 0) continue;

    const byRule = new Map<string, { open: number; overdue: number }>();
    for (const e of mine) {
      const row = byRule.get(e.rule_code) ?? { open: 0, overdue: 0 };
      row.open++;
      if (isOverdue(e.due_date, e.status, today)) row.overdue++;
      byRule.set(e.rule_code, row);
    }
    const overdue = [...byRule.values()].reduce((n, r) => n + r.overdue, 0);
    const lines = [...byRule.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([code, r]) =>
          `  ${code}  ${RULE_INFO[code]?.title ?? "Exception"}: ${r.open} open${r.overdue ? `, ${r.overdue} overdue` : ""}`,
      );

    out.push({
      to: m.email,
      subject:
        overdue > 0
          ? `Finance exceptions: ${mine.length} open, ${overdue} overdue`
          : `Finance exceptions: ${mine.length} open`,
      text: [
        `Hello${m.firstName ? ` ${m.firstName}` : ""},`,
        "",
        "Open finance exceptions in your queue:",
        ...lines,
        "",
        `Open the queue: ${appUrl.replace(/\/$/, "")}/finance/exceptions`,
      ].join("\n"),
    });
  }
  return out;
}
