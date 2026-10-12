import { headers } from "next/headers";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireMember } from "@/lib/auth/session";
import { describeAuthEvent } from "@/lib/security/auth-events-view";
import { trackSession } from "@/lib/security/auth-events";
import { currentSessionId } from "@/lib/security/sessions";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { PasswordForm, ProfileForm } from "./forms";
import { MfaCard, SessionsCard } from "./security-panels";

export const metadata = { title: "Account" };
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const member = await requireMember();
  const supabase = await createClient();
  const tz = member.profile.timezone || member.org.timezone || "UTC";

  // Make sure this browser has a row in the session list (sessions opened before Phase 15 have none).
  const { data: sessionData } = await supabase.auth.getSession();
  await trackSession(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    accessToken: sessionData.session?.access_token ?? null,
    headers: await headers(),
  });
  const currentId = await currentSessionId(supabase);

  const [{ data: factors }, { data: aal }, { data: role }, { data: sessions }, { data: events }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.from("roles").select("require_mfa").eq("id", member.roleId).maybeSingle(),
    supabase
      .from("user_sessions")
      .select("id, session_id, ua_family, created_at, last_seen_at")
      .eq("user_id", member.userId)
      .is("revoked_at", null)
      .order("last_seen_at", { ascending: false })
      .limit(20),
    supabase
      .from("auth_events")
      .select("id, event_type, method, at, ua_family, ip_address, ip_hash")
      .eq("user_id", member.userId)
      .order("at", { ascending: false })
      .limit(50),
  ]);

  const when = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account"
        description="Your name, designation, timezone, sign-in details, devices and login history."
      />
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="history">Login history</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Shown to colleagues in the inbox and on assignments.</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm
                profile={{
                  first_name: member.profile.first_name,
                  last_name: member.profile.last_name,
                  designation: member.profile.designation ?? "",
                  timezone: member.profile.timezone ?? "",
                  language: member.profile.language === "ar" ? "ar" : "en",
                }}
                email={member.user.email ?? ""}
                orgTimezone={member.org.timezone}
                roleName={member.roleName}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Password</CardTitle>
              <CardDescription>Choose a new password for your account.</CardDescription>
            </CardHeader>
            <CardContent>
              <PasswordForm />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="flex flex-col gap-6">
          <MfaCard
            factors={(factors?.totp ?? []).map((f) => ({ id: f.id, name: f.friendly_name ?? "Authenticator app", createdAt: f.created_at }))}
            required={role?.require_mfa === true}
            verifiedThisSession={aal?.currentLevel === "aal2"}
          />
          <SessionsCard
            sessions={(sessions ?? []).map((s) => ({
              id: s.id,
              device: s.ua_family ?? "Unknown device",
              lastSeen: when(s.last_seen_at),
              signedIn: when(s.created_at),
              current: s.session_id === currentId,
            }))}
          />
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Login history</CardTitle>
              <CardDescription>
                Your last 50 sign-ins and security changes. If you see something you do not recognise, sign out
                everywhere and change your password. Your administrator can see this list too. Full IP addresses
                are kept for 30 days; after that only an anonymous fingerprint remains.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead className="hidden sm:table-cell">Device</TableHead>
                    <TableHead className="hidden md:table-cell">Address</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(events ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground py-8 text-center">
                        Nothing recorded yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {(events ?? []).map((e) => {
                    const d = describeAuthEvent(e.event_type, e.method);
                    return (
                      <TableRow key={e.id}>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{when(e.at)}</TableCell>
                        <TableCell>
                          <Badge variant={d.tone}>{d.label}</Badge>
                        </TableCell>
                        <TableCell className="hidden text-sm sm:table-cell">{e.ua_family ?? "Unknown device"}</TableCell>
                        <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                          {e.ip_address ?? (e.ip_hash ? `anonymised · ${e.ip_hash.slice(0, 6)}` : "not recorded")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {member.permissions.length > 0 && (
            <p className="text-muted-foreground mt-3 text-xs">
              Administrators can review everyone&apos;s sign-ins under{" "}
              <Link className="underline" href="/settings/activity?view=logins">
                Activity log
              </Link>
              .
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
