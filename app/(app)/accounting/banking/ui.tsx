import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { CHEQUE_STATUS_LABELS, type ChequeStatus } from "@/lib/accounting/banking";
import { canAny, type MemberLike } from "@/lib/auth/can";

/** Small display pieces shared by the Banking pages (server components). */

export const BANKING_VIEW = [
  "accounting.banking.manage",
  "accounting.ledger.view",
  "accounting.journals.approve",
] as const;

export const canViewBanking = (m: MemberLike) => canAny(m, BANKING_VIEW);

/** Posted (with the journal number), waiting for the ledger start, or cancelled. */
export function PostingBadge({
  status,
  journalId,
  number,
}: {
  status: string;
  journalId: string | null;
  number?: string;
}) {
  if (status === "waiting_ledger_start")
    return <Badge variant="warning">Waiting for the ledger start</Badge>;
  if (status === "cancelled") return <Badge variant="secondary">Cancelled</Badge>;
  if (status === "not_due") return <Badge variant="outline">Posts on its date</Badge>;
  if (status === "not_posted") return <Badge variant="secondary">Never posted</Badge>;
  if (status === "reversed") return <Badge variant="secondary">Reversed</Badge>;
  return journalId ? (
    <Link href={`/accounting/journals/${journalId}`} className="text-primary text-xs underline">
      {number || "Posted"}
    </Link>
  ) : (
    <Badge variant="success">Posted</Badge>
  );
}

export function ChequeStatusBadge({ status }: { status: ChequeStatus }) {
  const variant =
    status === "cleared"
      ? "success"
      : status === "bounced"
        ? "destructive"
        : status === "cancelled" || status === "stale"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{CHEQUE_STATUS_LABELS[status]}</Badge>;
}
