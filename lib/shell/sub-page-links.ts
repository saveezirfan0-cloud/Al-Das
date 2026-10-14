import { PORTAL_SECTIONS } from "@/app/(app)/portal/sections";
import { canAny, type MemberLike } from "@/lib/auth/can";

import type { QuickLink } from "./quick-links";

/**
 * Pages reached only from inside another page (an in-page tab, a button, a section card), listed in Ctrl+K so they are
 * one search away like every menu page. Each is shown only to a member holding ANY of `anyOf`, which must match the
 * page's own check (tests/unit/sub-page-links.test.ts). Labels are the page headings. Menu pages are not repeated here.
 */
export type SubPageLink = QuickLink & { anyOf: readonly string[] };

const REVSHARE = [
  "finance.revshare.view",
  "finance.revshare.manage",
  "finance.revshare.verify",
  "finance.revshare.approve",
] as const;

export const SUB_PAGE_LINKS: readonly SubPageLink[] = [
  {
    href: "/front-desk/end-of-day",
    label: "End of day",
    keywords: ["sheet", "handover", "print", "unconfirmed", "close up"],
    hint: "Front desk",
    anyOf: ["frontdesk.use"],
  },
  {
    href: "/front-desk/qr",
    label: "Desk QR code",
    keywords: ["poster", "register", "walk-in", "print"],
    hint: "Front desk",
    anyOf: ["frontdesk.use"],
  },
  {
    href: "/dashboard/team",
    label: "Team lead dashboard",
    keywords: ["team lead", "sla", "agents", "workload"],
    hint: "Home",
    anyOf: ["reports.view", "inbox.view_all"],
  },
  {
    href: "/inbox/failed",
    label: "Failed messages",
    keywords: ["undelivered", "retry", "errors"],
    hint: "Messaging · Inbox",
    anyOf: ["inbox.send", "inbox.view_all"],
  },
  {
    href: "/campaigns/new",
    label: "New campaign",
    keywords: ["broadcast", "send"],
    hint: "Messaging · Campaigns",
    anyOf: ["campaigns.create"],
  },
  {
    href: "/campaigns/history",
    label: "Campaign history",
    keywords: ["sanoflow", "archive", "past campaigns"],
    hint: "Messaging · Campaigns",
    anyOf: ["campaigns.view"],
  },
  {
    href: "/campaigns/recurring",
    label: "Recurring campaigns",
    keywords: ["schedule", "repeat", "monthly"],
    hint: "Messaging · Campaigns",
    anyOf: ["campaigns.view"],
  },
  {
    href: "/flows/variables",
    label: "Flow variables",
    keywords: ["variables", "bots"],
    hint: "Messaging · Flows",
    anyOf: ["flows.manage"],
  },
  {
    href: "/recall/calls",
    label: "Recall call list",
    keywords: ["calls", "phone list"],
    hint: "Messaging · Recall",
    anyOf: ["campaigns.view"],
  },
  {
    href: "/recall/parallel-run",
    label: "Parallel run",
    keywords: ["make", "comparison", "cut-over"],
    hint: "Messaging · Recall",
    anyOf: ["reports.view"],
  },
  {
    href: "/reports/ai-quality",
    label: "AI reply quality",
    keywords: ["ai", "suggestions", "knowledge gaps"],
    hint: "Insights · Reports",
    anyOf: ["ai.insights.view"],
  },
  {
    href: "/reports/ads",
    label: "Ad attribution",
    keywords: ["meta ads", "click to whatsapp", "spend"],
    hint: "Insights · Reports",
    anyOf: ["ads.view"],
  },
  // Portal sections (the Follow-up Queue is already a Today menu entry)
  ...PORTAL_SECTIONS.filter((s) => s.href !== "/portal/follow-ups").map((s): SubPageLink => ({
    href: s.href,
    label: s.label,
    hint: "Insights · Portal",
    anyOf: [s.read],
  })),
  {
    href: "/finance/revenue-share/schemes",
    label: "Revenue share schemes",
    keywords: ["doctor incentives", "rules"],
    hint: "Finance · Doctor revenue share",
    anyOf: REVSHARE,
  },
  {
    href: "/finance/revenue-share/charges",
    label: "Doctor charges",
    keywords: ["charges to doctors", "deductions"],
    hint: "Finance · Doctor revenue share",
    anyOf: REVSHARE,
  },
];

/** The sub-pages this member may open, as quick links. */
export function subPageLinksFor(member: MemberLike): QuickLink[] {
  return SUB_PAGE_LINKS.filter((l) => canAny(member, l.anyOf)).map(
    ({ href, label, hint, keywords }) => ({ href, label, hint, keywords }),
  );
}
