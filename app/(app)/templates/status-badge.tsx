import { Badge } from "@/components/ui/badge";
import { statusInfo } from "@/lib/whatsapp/template-fields";

const VARIANT = {
  success: "success",
  warning: "warning",
  danger: "destructive",
  neutral: "secondary",
} as const;

export function StatusBadge({ status, archived }: { status: string; archived?: boolean }) {
  const info = statusInfo(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={VARIANT[info.tone]}>{info.label}</Badge>
      {archived && <Badge variant="outline">Archived</Badge>}
    </span>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  return (
    <Badge variant="outline" className="capitalize">
      {category.toLowerCase()}
    </Badge>
  );
}
