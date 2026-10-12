"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { acknowledgeAlert } from "./actions";

export function AcknowledgeButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await acknowledgeAlert(id);
          if (!res.ok) return void toast.error(res.error);
          router.refresh();
        })
      }
    >
      {pending && <Loader2 className="animate-spin" />} Mark reviewed
    </Button>
  );
}
