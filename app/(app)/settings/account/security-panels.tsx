"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Laptop, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { removeMfaFactor } from "@/app/(auth)/mfa/actions";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { signOutEverywhere, signOutOtherDevices, signOutThisDevice } from "./actions";

export function MfaCard({
  factors,
  required,
  verifiedThisSession,
}: {
  factors: Array<{ id: string; name: string; createdAt: string }>;
  required: boolean;
  verifiedThisSession: boolean;
}) {
  const router = useRouter();
  const enrolled = factors.length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {enrolled ? (
            <ShieldCheck className="size-5 text-emerald-600" />
          ) : (
            <ShieldAlert className="size-5 text-amber-600" />
          )}
          Two-step verification
          {required && <Badge variant="outline">Required for your role</Badge>}
        </CardTitle>
        <CardDescription>
          An authenticator app on your phone gives a 6-digit code at sign-in, so a stolen password
          alone is not enough to open patient data.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {factors.map((f) => (
          <div
            key={f.id}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <div>
              <div className="font-medium">{f.name}</div>
              <div className="text-muted-foreground text-xs">
                Added {new Date(f.createdAt).toLocaleDateString("en-GB")}
              </div>
            </div>
            <ConfirmDialog
              trigger={
                <Button variant="outline" size="sm" disabled={!verifiedThisSession}>
                  Remove
                </Button>
              }
              title="Remove this authenticator?"
              description={
                required
                  ? "Your role requires two-step verification, so you will be asked to set it up again straight away."
                  : "You will sign in with your password only."
              }
              confirmLabel="Remove"
              destructive
              onConfirm={async () => {
                const res = await removeMfaFactor(f.id);
                if (res.ok) {
                  toast.success("Authenticator removed.");
                  router.refresh();
                }
                return res;
              }}
            />
          </div>
        ))}
        {!enrolled && (
          <div>
            <Button asChild>
              <Link href="/mfa/enroll?next=/settings/account">Set up two-step verification</Link>
            </Button>
          </div>
        )}
        {enrolled && !verifiedThisSession && (
          <p className="text-muted-foreground text-xs">
            Verify your code at sign-in to manage your authenticator.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function SessionsCard({
  sessions,
}: {
  sessions: Array<{
    id: string;
    device: string;
    lastSeen: string;
    signedIn: string;
    current: boolean;
  }>;
}) {
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where you are signed in</CardTitle>
        <CardDescription>
          Devices that have signed in to your account. Sign out any you do not recognise.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {sessions.length === 0 && (
            <li className="text-muted-foreground text-sm">No devices recorded yet.</li>
          )}
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <Laptop className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {s.device}
                  {s.current && <Badge variant="success">This device</Badge>}
                </div>
                <div className="text-muted-foreground text-xs">
                  Last active {s.lastSeen} · signed in {s.signedIn}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <ConfirmDialog
            trigger={<Button variant="outline">Sign out this device</Button>}
            title="Sign out this device?"
            description="You will return to the sign-in page. Other devices stay signed in."
            confirmLabel="Sign out"
            onConfirm={async () => {
              await signOutThisDevice();
            }}
          />
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={others === 0}>
                Sign out other devices
              </Button>
            }
            title="Sign out all other devices?"
            description="Every device except this one will need to sign in again within the hour."
            confirmLabel="Sign out others"
            onConfirm={async () => {
              await signOutOtherDevices();
              toast.success("Other devices signed out.");
            }}
          />
          <ConfirmDialog
            trigger={<Button variant="destructive">Sign out everywhere</Button>}
            title="Sign out everywhere?"
            description="Every device, including this one, is signed out and must sign in again. Use this if you think your account was used by someone else."
            confirmLabel="Sign out everywhere"
            destructive
            onConfirm={async () => {
              await signOutEverywhere();
            }}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          Signing out a device ends its refresh token; a screen that is already open can stay usable
          for up to an hour until its short-lived access token expires.
        </p>
      </CardContent>
    </Card>
  );
}
