"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import {
  Bell,
  Building2,
  Download,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";

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
import {
  applyTheme,
  DARK_QUERY,
  parseThemePref,
  THEME_STORAGE_KEY,
  type ThemePref,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

import { setPresence, switchOrg } from "./actions";
import { usePwaInstall } from "./pwa";

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
  offline: "bg-neutral-500", // neutral-400 is under 3:1 on a white background
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
  const { canInstall, install } = usePwaInstall();
  // Read after mount so the server render and the first client render agree.
  const [theme, setTheme] = useState<ThemePref>("light");

  useEffect(() => {
    try {
      setTheme(parseThemePref(localStorage.getItem(THEME_STORAGE_KEY)));
    } catch {
      // Storage blocked: stay on the default.
    }
  }, []);

  // "Match system" follows the OS live while the app is open.
  useEffect(() => {
    if (theme !== "system") return;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => applyTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);

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

  function changeTheme(value: string) {
    const next = parseThemePref(value);
    setTheme(next);
    applyTheme(next);
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
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs">Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={changeTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden /> Match system
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
          <Link href="/settings/notifications">
            <Bell /> Notification settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        {canInstall && (
          <DropdownMenuItem onSelect={() => void install()}>
            <Download /> Install app
          </DropdownMenuItem>
        )}
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
