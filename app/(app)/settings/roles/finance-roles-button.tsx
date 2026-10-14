"use client";

import { useTransition } from "react";
import { Landmark, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { addFinanceRoles } from "./actions";

/** Admin only (the page shows it to full-access members; the action checks again). Safe to press twice. */
export function FinanceRolesButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await addFinanceRoles();
          if (res.ok) toast.success(res.message);
          else toast.error(res.error);
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Landmark aria-hidden />}
      Add finance and accounting roles
    </Button>
  );
}
