import { notFound } from "next/navigation";

import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { FlowBuilder, type BuilderFlow, type BuilderLookups } from "./flow-builder";

export const metadata = { title: "Flow builder" };

export default async function FlowBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("flows.manage");
  const { id } = await params;
  const admin = createAdminClient();
  const { data: flow } = await admin.from("flows").select("*").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!flow) notFound();

  const [channels, templates, teams, members, flows, segments, variables] = await Promise.all([
    admin.from("channels").select("id, name").eq("org_id", member.orgId).order("name"),
    admin.from("wa_templates").select("id, name, status, category").eq("org_id", member.orgId).is("archived_at", null).order("name"),
    admin.from("teams").select("id, name").eq("org_id", member.orgId).order("name"),
    admin.from("memberships").select("user_id, profiles(first_name, last_name, email)").eq("org_id", member.orgId).eq("status", "active"),
    admin.from("flows").select("id, name, status").eq("org_id", member.orgId).neq("id", id).order("name"),
    admin.from("segments").select("id, name").eq("org_id", member.orgId).order("name"),
    admin.from("flow_variables").select("key").eq("org_id", member.orgId).eq("enabled", true).order("key"),
  ]);

  const lookups: BuilderLookups = {
    channels: channels.data ?? [],
    templates: templates.data ?? [],
    teams: teams.data ?? [],
    people: (members.data ?? []).map((m) => ({ id: m.user_id, name: `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() || m.profiles?.email || "Member" })),
    flows: (flows.data ?? []).map((f) => ({ id: f.id, name: f.name, published: f.status === "active" })),
    segments: segments.data ?? [],
    variables: (variables.data ?? []).map((v) => v.key),
  };
  const tc = (flow.trigger_config as Record<string, unknown>) ?? {};
  const initial: BuilderFlow = {
    id: flow.id,
    name: flow.name,
    description: flow.description ?? "",
    status: flow.status as BuilderFlow["status"],
    version: flow.version,
    trigger_type: flow.trigger_type,
    // The stored webhook token hash never leaves the server.
    trigger_config: Object.fromEntries(Object.entries(tc).filter(([k]) => k !== "webhook_token_hash")),
    has_webhook_token: typeof tc.webhook_token_hash === "string",
    channel_id: flow.channel_id,
    graph: flow.graph as BuilderFlow["graph"],
    published_graph: (flow.published_graph as BuilderFlow["graph"] | null) ?? null,
  };
  return <FlowBuilder flow={initial} lookups={lookups} />;
}
