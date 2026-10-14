"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, MapPin } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ALL_BRANCHES,
  allowedLocations,
  BRANCH_COOKIE,
  chooseBranch,
  type BranchAccess,
} from "@/lib/branches/access";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Branch = { id: string; name: string };

/** Two letters for the rail tile: "Jumeirah" → "JU", "Al Barsha" → "AB". */
function short(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * Which branch the screens show: one of the member's branches, or all of them. Only narrows what they may see
 * (lib/branches/access.ts); the choice is a per-device cookie read by the pages. Branch names are fetched in the
 * browser so the layout stays query-free. Hidden when there is only one branch to choose.
 */
export function BranchSwitcher({
  orgId,
  access,
  cookieValue,
  variant,
}: {
  orgId: string;
  access: BranchAccess;
  cookieValue: string | null;
  variant: "rail" | "drawer";
}) {
  const router = useRouter();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [choice, setChoice] = useState(cookieValue);

  const accessKey = `${access.scope}:${access.ids.join(",")}`;
  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("locations")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name")
      .then(({ data }) => {
        if (!cancelled) setBranches(allowedLocations(data ?? [], access));
      });
    return () => {
      cancelled = true;
    };
    // accessKey stands for `access` (a new object on every render of the parent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, accessKey]);

  if (!branches || branches.length < 2) return null;

  const current = chooseBranch(
    choice,
    access,
    branches.map((b) => b.id),
  );
  const currentName = branches.find((b) => b.id === current)?.name ?? null;
  const label = currentName ?? "All my branches";

  function pick(value: string) {
    setChoice(value);
    document.cookie = `${BRANCH_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  const item = (value: string, text: string, selected: boolean) => (
    <DropdownMenuItem key={value} onSelect={() => pick(value)} className="gap-2">
      <Check className={cn("size-4", !selected && "invisible")} aria-hidden />
      {text}
    </DropdownMenuItem>
  );

  const menu = (
    <DropdownMenuContent side={variant === "rail" ? "right" : "bottom"} align="start">
      <DropdownMenuLabel>Show branch</DropdownMenuLabel>
      {item(ALL_BRANCHES, "All my branches", current === null)}
      <DropdownMenuSeparator />
      {branches.map((b) => item(b.id, b.name, current === b.id))}
    </DropdownMenuContent>
  );

  if (variant === "rail")
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Branch: ${label}. Change branch`}
          title={`Branch: ${label}`}
          className="bg-rail-muted text-rail-foreground hover:bg-rail-hover flex size-11 flex-col items-center justify-center rounded-xl text-[10px] leading-none font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <MapPin className="mb-0.5 size-4" aria-hidden />
          {currentName ? short(currentName) : "ALL"}
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-10 w-full items-center gap-2 rounded-lg border px-3 text-left text-sm outline-none focus-visible:ring-2">
        <MapPin className="text-muted-foreground size-4" aria-hidden />
        <span className="text-muted-foreground">Branch</span>
        <span className="ml-auto truncate font-medium">{label}</span>
      </DropdownMenuTrigger>
      {menu}
    </DropdownMenu>
  );
}
