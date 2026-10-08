import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/page-header";
import { requireMember } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const member = await requireMember();
  const supabase = await createClient();
  const [{ count: members }, { count: teams }, { count: online }] = await Promise.all([
    supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("status", "active"),
    supabase.from("teams").select("id", { count: "exact", head: true }).eq("org_id", member.orgId),
    supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("presence", "online"),
  ]);

  const tiles = [
    { label: "Team members", value: members ?? 0, hint: "active accounts" },
    { label: "Online now", value: online ?? 0, hint: "presence" },
    { label: "Teams", value: teams ?? 0, hint: "queues & round-robin" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Welcome back${member.profile.first_name ? `, ${member.profile.first_name}` : ""}`}
        description="Conversation, enquiry and appointment metrics arrive with their modules. Workspace basics are below."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardHeader>
              <CardDescription>{t.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{t.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">{t.hint}</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
