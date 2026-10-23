import Link from "next/link";
import { EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

export const metadata = { title: "Page hidden" };
export const dynamic = "force-dynamic";

/**
 * Where a page navigation lands when its menu entry is hidden for this person: for everyone (Settings, Menu) or for
 * them (Settings, Users, Menu access). The gate is requireMember() in lib/auth/session.ts.
 */
export default async function PageHiddenPage() {
  const member = await requireMember();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <EyeOff className="size-6" aria-hidden />
      </span>
      <h1 className="text-lg font-semibold">This page is hidden from your menu</h1>
      <p className="text-muted-foreground text-sm">
        Your administrator has hidden this part of Pulse for you. If you need it for your work, ask
        them to show it again.
      </p>
      {can(member, "settings.manage") && (
        <p className="text-muted-foreground text-xs">
          You can change this under{" "}
          <Link href="/settings/menu" className="text-primary underline-offset-4 hover:underline">
            Settings, Menu
          </Link>{" "}
          (everyone) or Settings, Users, Menu access (one person).
        </p>
      )}
      <Button asChild>
        <Link href="/dashboard">Back to the dashboard</Link>
      </Button>
    </div>
  );
}
