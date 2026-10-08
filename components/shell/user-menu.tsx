"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Building2, LogOut, Settings, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { setPresence, switchOrg } from "./actions";

export type Presence = "online" | "away" | "offline";

export type UserMenuProps = {
  userId: string;
  orgId: string;
  name: string;
  email: string;
  roleName: string;
  presence: Presence;
  orgs: Array<{ id: string; name: string }>;
};

export const PRESENCE_COLOR: Record<Presence, string> = {
  online: "bg-emerald-500",
  away: "bg-amber-500",
  offline: "bg-neutral-400",
};

export function initials(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1 && parts[0]) return parts[0].slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

export function PresenceDot({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <span
      className={cn(
        "border-background inline-block size-2.5 rounded-full border-2",
        PRESENCE_COLOR[presence],
        className,
      )}
      aria-label={presence}
    />
  );
}

export function UserMenu({
  name,
  email,
  roleName,
  presence: initialPresence,
  orgs,
  orgId,
}: UserMenuProps) {
  const [presence, setLocalPresence] = useState<Presence>(initialPresence);
  const [, startTransition] = useTransition();

  // Coming back to the app marks you online; leaving it does not (the user picks Away).
  useEffect(() => {
    if (initialPresence === "offline") {
      startTransition(async () => {
        await setPresence("online");
        setLocalPresence("online");
      });
    }
  }, [initialPresence]);

  function changePresence(value: string) {
    const next = value as Presence;
    setLocalPresence(next);
    startTransition(() => setPresence(next));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-9 gap-2 px-1.5">
          <span className="relative">
            <Avatar>
              <AvatarFallback>{initials(name, email)}</AvatarFallback>
            </Avatar>
            <PresenceDot presence={presence} className="absolute -right-0.5 -bottom-0.5" />
          </span>
          <span className="hidden max-w-32 truncate text-sm md:inline">{name || email}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{name || email}</div>
          <div className="text-muted-foreground truncate text-xs">{email}</div>
          <div className="text-muted-foreground text-xs">{roleName}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs">Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={presence} onValueChange={changePresence}>
          <DropdownMenuRadioItem value="online">
            <PresenceDot presence="online" /> Online
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="away">
            <PresenceDot presence="away" /> Away
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="offline">
            <PresenceDot presence="offline" /> Appear offline
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {orgs.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Workspace
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={orgId}
              onValueChange={(id) => startTransition(() => switchOrg(id))}
            >
              {orgs.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id}>
                  <Building2 /> {o.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/account">
            <UserRound /> Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <form action="/auth/signout" method="post" className="w-full">
            <button type="submit" className="flex w-full items-center gap-2">
              <LogOut /> Sign out
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
