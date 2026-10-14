import { can, type MemberLike } from "@/lib/auth/can";

/** Recall's in-page tabs, each with the key its page checks (tests/unit/nav-integrity.test.ts keeps them in step). */
export const RECALL_TABS = [
  { href: "/recall", label: "Programmes", permission: "campaigns.view" },
  { href: "/recall/calls", label: "Call list", permission: "campaigns.view" },
  { href: "/recall/parallel-run", label: "Parallel run", permission: "reports.view" },
] as const;

/** The tabs this member may open (plain data for the client strip). */
export function recallTabsFor(member: MemberLike): Array<{ href: string; label: string }> {
  return RECALL_TABS.filter((t) => can(member, t.permission)).map(({ href, label }) => ({
    href,
    label,
  }));
}
