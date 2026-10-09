import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, type CampaignStatus } from "@/lib/campaigns/constants";

const VARIANT: Record<
  CampaignStatus,
  "default" | "secondary" | "outline" | "success" | "warning" | "destructive"
> = {
  preparing: "outline",
  scheduled: "secondary",
  queued: "secondary",
  sending: "default",
  paused: "warning",
  completed: "success",
  cancelled: "outline",
  failed: "destructive",
};

export function CampaignStatusBadge({ status }: { status: string }) {
  const s = status as CampaignStatus;
  return <Badge variant={VARIANT[s] ?? "outline"}>{STATUS_LABEL[s] ?? status}</Badge>;
}

const RECIPIENT_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "success" | "warning" | "destructive"
> = {
  pending: "outline",
  queued: "secondary",
  sent: "secondary",
  delivered: "default",
  read: "success",
  failed: "destructive",
  skipped: "warning",
};

export function RecipientStatusBadge({ status }: { status: string }) {
  return <Badge variant={RECIPIENT_VARIANT[status] ?? "outline"}>{status}</Badge>;
}
