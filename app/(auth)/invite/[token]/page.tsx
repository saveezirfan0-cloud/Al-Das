import type { Metadata } from "next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hashInviteToken, inviteState } from "@/lib/invites/token";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { AcceptInviteForm } from "./accept-form";

export const metadata: Metadata = { title: "Accept invite" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("invites")
    .select("id, email, expires_at, accepted_at, revoked_at, orgs(name), roles(name)")
    .eq("token_hash", hashInviteToken(decodeURIComponent(token)))
    .maybeSingle();

  if (!invite) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Invite not found</AlertTitle>
        <AlertDescription>
          This link is not valid. Ask your administrator for a new invite.
        </AlertDescription>
      </Alert>
    );
  }

  const state = inviteState(invite);
  if (state !== "valid") {
    const text = {
      expired: "This invite has expired.",
      accepted: "This invite has already been used.",
      revoked: "This invite was revoked.",
    }[state];
    return (
      <Alert>
        <AlertTitle>Invite unavailable</AlertTitle>
        <AlertDescription>
          {text} Ask your administrator for a new one.
          <Button asChild variant="link" className="px-0">
            <a href="/login">Go to sign in</a>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const signedInAsInvitee =
    !!user && (user.email ?? "").toLowerCase() === invite.email.toLowerCase();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join {invite.orgs?.name ?? "the workspace"}</CardTitle>
        <CardDescription>
          You were invited as <strong>{invite.roles?.name ?? "a member"}</strong> using{" "}
          <strong>{invite.email}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {user && !signedInAsInvitee ? (
          <Alert variant="destructive">
            <AlertTitle>Signed in as someone else</AlertTitle>
            <AlertDescription>
              This invite is for {invite.email}. Sign out and open the link again.
              <form action="/auth/signout" method="post">
                <Button type="submit" variant="outline" size="sm" className="mt-2">
                  Sign out
                </Button>
              </form>
            </AlertDescription>
          </Alert>
        ) : (
          <AcceptInviteForm token={decodeURIComponent(token)} needsPassword={!signedInAsInvitee} />
        )}
      </CardContent>
    </Card>
  );
}
