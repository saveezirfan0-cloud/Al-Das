import { Construction } from "lucide-react";

import { PageHeader } from "./page-header";

export function ComingSoon({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} />
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-20 text-center">
        <Construction className="size-8" />
        <p className="text-sm">This module arrives in {phase}.</p>
      </div>
    </div>
  );
}
