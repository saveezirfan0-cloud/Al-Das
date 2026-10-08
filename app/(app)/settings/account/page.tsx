import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireMember } from "@/lib/auth/session";

import { PasswordForm, ProfileForm } from "./forms";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const member = await requireMember();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account"
        description="Your name, designation, timezone and sign-in details."
      />
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
    </div>
  );
}
