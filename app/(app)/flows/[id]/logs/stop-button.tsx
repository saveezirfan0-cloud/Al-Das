"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, OctagonX } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { stopFlowRun } from "../../actions";

export function StopRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await stopFlowRun(runId);
        setBusy(false);
        if (!r.ok) return void toast.error(r.error);
        toast.success(r.message);
        router.refresh();
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <OctagonX className="size-4" />}
      Stop this run
    </Button>
  );
}
