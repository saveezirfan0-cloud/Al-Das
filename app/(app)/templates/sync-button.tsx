"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { syncTemplatesAction } from "./actions";

export function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await syncTemplatesAction();
          if (r.ok) {
            toast.success(r.message ?? "Synced.");
            router.refresh();
          } else toast.error(r.error);
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync templates
    </Button>
  );
}
