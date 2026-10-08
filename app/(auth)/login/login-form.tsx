"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { sendMagicLink, signInWithPassword, type AuthState } from "./actions";

export function LoginForm({ next, initialError }: { next?: string; initialError?: string }) {
  const [pwState, pwAction, pwPending] = useActionState<AuthState, FormData>(
    signInWithPassword,
    initialError ? { error: initialError } : undefined,
  );
  const [mlState, mlAction, mlPending] = useActionState<AuthState, FormData>(
    sendMagicLink,
    undefined,
  );
  const [tab, setTab] = useState("password");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Staff access to the Al Das clinic platform.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="magic">Email link</TabsTrigger>
          </TabsList>
          <TabsContent value="password">
            <form action={pwAction} className="flex flex-col gap-4 pt-2">
              <input type="hidden" name="next" value={next ?? ""} />
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
              {pwState?.error && (
                <p className="text-destructive text-sm" role="alert">
                  {pwState.error}
                </p>
              )}
              <Button type="submit" disabled={pwPending} className="w-full">
                {pwPending && <Loader2 className="animate-spin" />}
                Sign in
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="magic">
            <form action={mlAction} className="flex flex-col gap-4 pt-2">
              <input type="hidden" name="next" value={next ?? ""} />
              <div className="grid gap-2">
                <Label htmlFor="email-magic">Email</Label>
                <Input id="email-magic" name="email" type="email" autoComplete="email" required />
              </div>
              {mlState?.error && (
                <p className="text-destructive text-sm" role="alert">
                  {mlState.error}
                </p>
              )}
              {mlState?.message && (
                <p className="text-sm text-emerald-700" role="status">
                  {mlState.message}
                </p>
              )}
              <Button type="submit" disabled={mlPending} className="w-full" variant="secondary">
                {mlPending && <Loader2 className="animate-spin" />}
                Send sign-in link
              </Button>
            </form>
          </TabsContent>
        </Tabs>
        <p className="text-muted-foreground mt-6 text-center text-xs">
          New here? Ask an administrator to invite you.
        </p>
      </CardContent>
    </Card>
  );
}
