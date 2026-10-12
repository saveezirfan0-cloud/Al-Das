import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { readAiSettings } from "@/lib/ai/settings";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

import { CopilotWorkspace } from "./copilot-workspace";

export const metadata = { title: "Campaign Copilot" };
export const dynamic = "force-dynamic";

export default async function CampaignCopilotPage() {
  const member = await requirePerm("campaigns.create");
  if (!can(member, "campaigns.ai")) redirect("/campaigns");
  const aiEnabled = readAiSettings(member.org.settings).enabled;
  const supabase = await createClient();
  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, display_phone")
    .eq("org_id", member.orgId)
    .eq("status", "active")
    .order("name");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Campaign Copilot"
        description="Describe who to reach and what to say. You get a checked audience with its size, and English and Arabic wording checked against WhatsApp's template rules. Nothing is sent or submitted from here."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns/new">New campaign</Link>
        </Button>
      </PageHeader>
      {aiEnabled ? (
        <CopilotWorkspace
          channels={(channels ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            phone: c.display_phone,
          }))}
          canTemplates={can(member, "templates.manage")}
        />
      ) : (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          AI is turned off for this workspace. An administrator can turn it on in Settings, AI &amp;
          knowledge base. Campaigns, segments and templates work as before without it.
        </p>
      )}
    </div>
  );
}
