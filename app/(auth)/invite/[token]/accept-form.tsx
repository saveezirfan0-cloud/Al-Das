"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { acceptInvite, type AcceptState } from "./actions";

export function AcceptInviteForm({
  token,
  needsPassword,
}: {
  token: string;
  needsPassword: boolean;
}) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInvite, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="first_name">First name</Label>
          <Input id="first_name" name="first_name" autoComplete="given-name" required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="last_name">Last name</Label>
          <Input id="last_name" name="last_name" autoComplete="family-name" />
        </div>
      </div>
      {needsPassword && (
        <div className="grid gap-2">
          <Label htmlFor="password">Choose a password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <p className="text-muted-foreground text-xs">At least 8 characters.</p>
        </div>
      )}
      {state?.error && (
        <p className="text-destructive text-sm" role="alert">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending && <Loader2 className="animate-spin" />}
        {needsPassword ? "Create account and join" : "Join workspace"}
      </Button>
    </form>
  );
}
