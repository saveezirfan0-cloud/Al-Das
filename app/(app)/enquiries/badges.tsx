import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, type EnquiryStatus } from "@/lib/enquiries/status";
import { cn } from "@/lib/utils";

const VARIANT = {
  open: "secondary",
  won: "success",
  lost: "destructive",
  disqualified: "warning",
} as const;

export function StatusBadge({ status }: { status: EnquiryStatus }) {
  return <Badge variant={VARIANT[status]}>{STATUS_LABELS[status]}</Badge>;
}

const DOT: Record<string, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
  teal: "bg-teal-500",
};

export function StageDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        DOT[color] ?? DOT.slate,
        className,
      )}
    />
  );
}
