"use client";

import * as React from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeNextPath } from "@/lib/security/next-path";
import { createClient } from "@/lib/supabase/client";

import { confirmMfaVerified } from "../actions";

/** Asks for the 6-digit code once per session (aal1 → aal2). */
export function VerifyForm({ next }: { next?: string }) {
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp[0];
    if (!factor) {
      setBusy(false);
      return setError("No authenticator app is set up on this account.");
    }
    const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) {
      setBusy(false);
      return setError("Could not start the check. Try again.");
    }
    const verified = await supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.data.id,
      code: code.trim(),
    });
    if (verified.error) {
      setBusy(false);
      setCode("");
      return setError("That code is not right. Wait for the next one and try again.");
    }
    const res = await confirmMfaVerified();
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.replace(safeNextPath(next, "/"));
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" /> Two-step verification
        </CardTitle>
        <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="mfa-code">6-digit code</Label>
            <Input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy && <Loader2 className="animate-spin" />} Verify
          </Button>
        </form>
        <form action="/auth/signout" method="post" className="mt-3">
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            Sign out
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
