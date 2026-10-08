import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Activity } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMember, getCurrentUser } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";

import { CreateWorkspaceForm } from "./create-form";

export const metadata: Metadata = { title: "Set up workspace" };

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getCurrentMember();
  if (member) redirect("/dashboard");

  const allowed = serverEnv().ALLOW_WORKSPACE_CREATION;

  return (
    <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2 font-semibold">
        <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
          <Activity className="size-4" />
        </span>
        Pulse
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>No workspace yet</CardTitle>
          <CardDescription>
            Signed in as {user.email}.{" "}
            {allowed
              ? "Create the clinic workspace to get started."
              : "You need an invite from an administrator."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {allowed ? (
            <CreateWorkspaceForm />
          ) : (
            <Alert>
              <AlertTitle>Waiting for an invite</AlertTitle>
              <AlertDescription>
                Once an administrator invites this email, open the link they send you.
              </AlertDescription>
            </Alert>
          )}
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="ghost" size="sm" className="w-full">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
