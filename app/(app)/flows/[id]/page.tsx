import { notFound } from "next/navigation";

import { readAiSettings } from "@/lib/ai/settings";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadCustomFields } from "@/lib/contacts/server";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import type { BuilderFlow, BuilderLookups } from "./flow-builder";
import { FlowBuilderLoader } from "./flow-builder-loader";

export const metadata = { title: "Flow builder" };

export default async function FlowBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("flows.manage");
  const { id } = await params;
  const admin = createAdminClient();
  const { data: flow } = await admin
    .from("flows")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) notFound();

  const [
    channels,
    templates,
    teams,
    members,
    flows,
    segments,
    variables,
    pipelines,
    stages,
    labels,
    services,
    specialists,
    locations,
    enquiryFields,
  ] = await Promise.all([
    admin
      .from("channels")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("type", "whatsapp")
      .order("name"),
    admin
      .from("wa_templates")
      .select("id, name, status, category")
      .eq("org_id", member.orgId)
      .neq("category", "AUTHENTICATION")
      .is("archived_at", null)
      .order("name"),
    admin.from("teams").select("id, name").eq("org_id", member.orgId).order("name"),
    admin
      .from("memberships")
      .select("user_id, profiles(first_name, last_name, email)")
      .eq("org_id", member.orgId)
      .eq("status", "active"),
    admin
      .from("flows")
      .select("id, name, status")
      .eq("org_id", member.orgId)
      .neq("id", id)
      .order("name"),
    admin
      .from("segments")
      .select("id, name, drip_flow_id")
      .eq("org_id", member.orgId)
      .order("name"),
    admin
      .from("flow_variables")
      .select("key")
      .eq("org_id", member.orgId)
      .eq("enabled", true)
      .order("key"),
    admin
      .from("pipelines")
      .select("id, name")
      .eq("org_id", member.orgId)
      .is("archived_at", null)
      .order("sort"),
    admin.from("stages").select("id, name, pipeline_id").eq("org_id", member.orgId).order("sort"),
    admin
      .from("tags")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("scope", "conversation")
      .order("name"),
    admin
      .from("services")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
    admin
      .from("specialists")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
    admin
      .from("locations")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
    loadCustomFields(admin, member.orgId, "enquiry"),
  ]);

  const lookups: BuilderLookups = {
    channels: channels.data ?? [],
    templates: templates.data ?? [],
    teams: teams.data ?? [],
    people: (members.data ?? []).map((m) => ({
      id: m.user_id,
      name:
        `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
        m.profiles?.email ||
        "Member",
    })),
    flows: (flows.data ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      published: f.status === "active",
    })),
    segments: segments.data ?? [],
    variables: (variables.data ?? []).map((v) => v.key),
    pipelines: (pipelines.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: (stages.data ?? [])
        .filter((st) => st.pipeline_id === p.id)
        .map((st) => ({ id: st.id, name: st.name })),
    })),
    labels: labels.data ?? [],
    lostReasons: readEnquirySettings(member.org.settings).lost_reasons,
    enquiryFields: enquiryFields.map((f) => ({ key: f.key, label: f.label })),
    services: services.data ?? [],
    specialists: specialists.data ?? [],
    locations: locations.data ?? [],
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
    trigger_config: Object.fromEntries(
      Object.entries(tc).filter(([k]) => k !== "webhook_token_hash"),
    ),
    has_webhook_token: typeof tc.webhook_token_hash === "string",
    channel_id: flow.channel_id,
    graph: flow.graph as BuilderFlow["graph"],
    published_graph: (flow.published_graph as BuilderFlow["graph"] | null) ?? null,
    ai_review_required: flow.ai_review_required,
  };
  return (
    <FlowBuilderLoader
      flow={initial}
      lookups={lookups}
      canAi={can(member, "flows.ai") && readAiSettings(member.org.settings).enabled}
    />
  );
}
