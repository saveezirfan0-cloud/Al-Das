import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL } from "@/lib/templates/rules";

const VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  APPROVED: "success",
  PENDING: "warning",
  IN_APPEAL: "warning",
  REJECTED: "destructive",
  PAUSED: "warning",
  DISABLED: "destructive",
  LIMIT_EXCEEDED: "warning",
  DRAFT: "outline",
  DELETED: "secondary",
  PENDING_DELETION: "secondary",
};

export function StatusBadge({ status, archived }: { status: string; archived?: boolean }) {
  if (archived) return <Badge variant="secondary">Archived</Badge>;
  return <Badge variant={VARIANT[status] ?? "secondary"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function QualityDot({ quality }: { quality: string | null }) {
  if (!quality || quality === "UNKNOWN") return null;
  const color =
    quality === "GREEN" ? "bg-emerald-500" : quality === "YELLOW" ? "bg-amber-500" : "bg-red-500";
  return (
    <span
      title={`Quality: ${quality.toLowerCase()}`}
      className={`inline-block size-2 rounded-full ${color}`}
    />
  );
}
