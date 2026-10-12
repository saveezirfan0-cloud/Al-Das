"use client";

import { useRouter } from "next/navigation";

import { RunButton } from "@/components/finance/forms";

import { openCashup } from "./actions";

export function StartButton({ branch, date }: { branch: string; date: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      size="default"
      action={async () => {
        const r = await openCashup({ branch, date });
        if (r.ok) router.refresh();
        return r.ok ? { ok: true as const, message: "Cash-up started." } : r;
      }}
    >
      Start the cash-up for {date}
    </RunButton>
  );
}
