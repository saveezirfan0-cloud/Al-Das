import { notFound } from "next/navigation";

import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { flowGraphSchema, type TriggerConfig, type TriggerType } from "@/lib/flow-engine/types";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import { createClient } from "@/lib/supabase/server";
import type { Filter } from "@/lib/filters/ast";

import { FlowBuilder } from "./builder";
import type { BuilderLookups } from "./lookups";

export const metadata = { title: "Flow builder" };
export const dynamic = "force-dynamic";

export default async function FlowBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("flows.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();

  const { data: flow } = await supabase
    .from("flows")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) notFound();

  const [
    templates,
    members,
    teams,
    pipelines,
    stages,
    channels,
    flows,
    specialists,
    locations,
    services,
    variables,
    live,
  ] = await Promise.all([
    supabase
      .from("wa_templates")
      .select("id, name, language, status")
      .eq("org_id", member.orgId)
      .is("archived_at", null)
      .neq("status", "DELETED")
      .order("name"),
    supabase
      .from("memberships")
      .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
      .eq("org_id", member.orgId)
      .eq("status", "active"),
    supabase.from("teams").select("id, name").eq("org_id", member.orgId).order("name"),
    supabase
      .from("pipelines")
      .select("id, name")
      .eq("org_id", member.orgId)
      .is("archived_at", null)
      .order("sort"),
    supabase
      .from("stages")
      .select("id, name, pipeline_id")
      .eq("org_id", member.orgId)
      .order("sort"),
    supabase.from("channels").select("id, name").eq("org_id", member.orgId).order("name"),
    supabase
      .from("flows")
      .select("id, name")
      .eq("org_id", member.orgId)
      .neq("id", id)
      .order("name"),
    supabase.from("specialists").select("id, name").eq("org_id", member.orgId).order("name"),
    supabase.from("locations").select("id, name").eq("org_id", member.orgId).order("name"),
    supabase.from("services").select("id, name").eq("org_id", member.orgId).order("name"),
    supabase.from("flow_variables").select("key").eq("org_id", member.orgId),
    flow.version > 0
      ? supabase
          .from("flow_versions")
          .select("graph")
          .eq("flow_id", id)
          .eq("version", flow.version)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const stageByPipeline = new Map<string, Array<{ id: string; name: string }>>();
  for (const s of stages.data ?? [])
    stageByPipeline.set(s.pipeline_id, [
      ...(stageByPipeline.get(s.pipeline_id) ?? []),
      { id: s.id, name: s.name },
    ]);

  const lookups: BuilderLookups = {
    templates: templates.data ?? [],
    people: (members.data ?? []).map((m) => {
      const p = m.profiles as { first_name?: string; last_name?: string; email?: string } | null;
      return {
        id: m.user_id,
        name: `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim() || p?.email || "Member",
      };
    }),
    teams: teams.data ?? [],
    pipelines: (pipelines.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: stageByPipeline.get(p.id) ?? [],
    })),
    channels: channels.data ?? [],
    flows: flows.data ?? [],
    // Only record types the person may edit: the flow can write exactly what its publisher can.
    portalObjects: PORTAL_OBJECTS.filter((o) => o.writePerm && can(member, o.writePerm)).map(
      (o) => ({
        key: o.key,
        label: o.label,
        fields: o.columns.filter((c) => !c.readOnly).map((c) => c.key),
      }),
    ),
    specialists: specialists.data ?? [],
    locations: locations.data ?? [],
    services: services.data ?? [],
    permissions: PERMISSIONS.map((p) => p.key).filter((k) => !k.includes("*")),
  };

  const parsed = flowGraphSchema.safeParse(flow.draft_graph);
  const graph = parsed.success ? parsed.data : { nodes: [], edges: [] };
  const liveGraph = JSON.stringify(live.data?.graph ?? null);

  return (
    <FlowBuilder
      lookups={lookups}
      flow={{
        id: flow.id,
        status: flow.status as "draft" | "active" | "paused",
        version: flow.version,
        graph,
        hasWebhookToken: !!flow.webhook_token_hash,
        knownVariables: (variables.data ?? []).map((v) => v.key),
        unpublished: flow.version === 0 || liveGraph !== JSON.stringify(flow.draft_graph),
        settings: {
          name: flow.name,
          description: flow.description ?? "",
          trigger_type: flow.trigger_type as TriggerType,
          trigger_config: flow.trigger_config as TriggerConfig,
          conditions: (flow.conditions as Filter | null) ?? null,
          channel_id: flow.channel_id,
        },
      }}
    />
  );
}
