import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { MENU_CHOICES, readOrgMenuHidden } from "@/lib/nav/menu-visibility";
import { createAdminClient } from "@/lib/supabase/admin";

import { WorkspaceMenuForm } from "./menu-form";

export const metadata = { title: "Menu" };

export default async function MenuSettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  // read fresh (not member.org) so the form shows what was just saved
  const [{ data: org }, { count: personal }] = await Promise.all([
    admin.from("orgs").select("settings").eq("id", member.orgId).single(),
    admin
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .filter("menu_hidden", "neq", "{}"),
  ]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Menu"
        description="Choose which parts of Pulse appear in the menu for everyone in this workspace."
      />
      <Card>
        <CardHeader>
          <CardTitle>Shown for everyone</CardTitle>
          <CardDescription>
            Untick a module the clinic does not use. It leaves the menu, the phone tabs and quick
            search for every user, and its pages say they are hidden. Dashboard and Settings are
            always shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkspaceMenuForm
            choices={MENU_CHOICES}
            initialHidden={readOrgMenuHidden(org?.settings)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>For one person</CardTitle>
          <CardDescription>
            Each person already sees only what their role allows. To hide more for one person,
            choose their menu when you invite them, or open their row under{" "}
            <Link
              href="/settings/users"
              className="text-primary underline-offset-4 hover:underline"
            >
              Users
            </Link>
            , Menu access.{" "}
            {personal
              ? `${personal} ${personal === 1 ? "person has" : "people have"} their own menu.`
              : "Nobody has their own menu yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          Hiding a menu entry never gives anyone more access. What a person can do is set by their{" "}
          <Link href="/settings/roles" className="text-primary underline-offset-4 hover:underline">
            role
          </Link>
          .
        </CardContent>
      </Card>
    </div>
  );
}
