import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { TriggerType } from "@/lib/flow-engine/types";

import { FlowsWorkspace } from "./flows-workspace";
import type { FlowListItem, VariableItem } from "./types";

export const metadata = { title: "Flows" };
export const dynamic = "force-dynamic";

export default async function FlowsPage() {
  const member = await requirePerm("flows.manage");
  const supabase = await createClient();
  const [
    { data: flows },
    { data: counts },
    { data: variables },
    { data: channels },
    { data: versions },
  ] = await Promise.all([
    supabase
      .from("flows")
      .select(
        "id, name, description, status, trigger_type, channel_id, version, updated_at, published_at, draft_graph",
      )
      .eq("org_id", member.orgId)
      .order("updated_at", { ascending: false }),
    supabase
      .from("v_flow_run_counts")
      .select("flow_id, completed, failed, live, last_run_at")
      .eq("org_id", member.orgId),
    supabase
      .from("flow_variables")
      .select("id, key, label, value_type, default_value, description")
      .eq("org_id", member.orgId)
      .order("key"),
    supabase.from("channels").select("id, name").eq("org_id", member.orgId).order("name"),
    supabase.from("flow_versions").select("flow_id, version, graph").eq("org_id", member.orgId),
  ]);

  const byFlow = new Map((counts ?? []).map((c) => [c.flow_id, c]));
  const live = new Map(
    (versions ?? []).map((v) => [`${v.flow_id}:${v.version}`, JSON.stringify(v.graph)]),
  );
  const items: FlowListItem[] = (flows ?? []).map((f) => {
    const c = byFlow.get(f.id);
    const published = live.get(`${f.id}:${f.version}`);
    return {
      id: f.id,
      name: f.name,
      description: f.description,
      status: f.status as FlowListItem["status"],
      trigger_type: f.trigger_type as TriggerType,
      channel_id: f.channel_id,
      version: f.version,
      updated_at: f.updated_at,
      published_at: f.published_at,
      completed: c?.completed ?? 0,
      failed: c?.failed ?? 0,
      live: c?.live ?? 0,
      last_run_at: c?.last_run_at ?? null,
      unpublished: f.version === 0 || published !== JSON.stringify(f.draft_graph),
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Flows"
        description="Bots and automations that run on conversations, enquiries, appointments, webhooks and schedules."
      />
      <FlowsWorkspace
        flows={items}
        variables={(variables ?? []) as VariableItem[]}
        channels={channels ?? []}
      />
    </div>
  );
}
