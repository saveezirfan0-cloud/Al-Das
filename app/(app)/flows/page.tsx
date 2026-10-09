import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { FlowsList, type FlowRow } from "./flows-list";

export const metadata = { title: "Flows" };

export default async function FlowsPage() {
  const member = await requirePerm("flows.manage");
  const admin = createAdminClient();
  const [{ data: flows }, { data: counts }, { data: channels }] = await Promise.all([
    admin
      .from("flows")
      .select("id, name, status, trigger_type, channel_id, version, updated_at")
      .eq("org_id", member.orgId)
      .order("updated_at", { ascending: false }),
    admin
      .from("v_flow_run_counts")
      .select("flow_id, completed, failed, pending")
      .eq("org_id", member.orgId),
    admin.from("channels").select("id, name").eq("org_id", member.orgId),
  ]);
  const byFlow = new Map((counts ?? []).map((c) => [c.flow_id, c]));
  const channelName = new Map((channels ?? []).map((c) => [c.id, c.name]));
  const rows: FlowRow[] = (flows ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    status: f.status as FlowRow["status"],
    trigger_type: f.trigger_type,
    channel: f.channel_id ? (channelName.get(f.channel_id) ?? "—") : "All numbers",
    version: f.version,
    updated_at: f.updated_at,
    ok: Number(byFlow.get(f.id)?.completed ?? 0),
    failed: Number(byFlow.get(f.id)?.failed ?? 0),
    waiting: Number(byFlow.get(f.id)?.pending ?? 0),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Flows"
        description="Automations and bots: what starts them, which number they use, and how their runs are going."
      >
        <Button variant="outline" asChild>
          <Link href="/flows/variables">Variables</Link>
        </Button>
      </PageHeader>
      <FlowsList rows={rows} />
    </div>
  );
}
