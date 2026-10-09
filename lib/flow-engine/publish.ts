import "server-only";

import { can, type MemberLike } from "@/lib/auth/can";
import { validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import {
  nodeDataSchemas,
  type FlowGraph,
  type TriggerConfig,
  type TriggerType,
} from "@/lib/flow-engine/types";
import { getPortalObject } from "@/lib/portal/objects";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";

type FlowRow = Tables<"flows">;

/** Things the graph points at must exist in this workspace and be allowed for the publisher. */
export async function checkReferences(
  admin: AdminClient,
  orgId: string,
  flowId: string,
  graph: FlowGraph,
  member: MemberLike,
): Promise<GraphIssue[]> {
  const issues: GraphIssue[] = [];
  const err = (nodeId: string, message: string) =>
    issues.push({ severity: "error", nodeId, message });
  const warn = (nodeId: string, message: string) =>
    issues.push({ severity: "warning", nodeId, message });

  const ids = (pick: (n: FlowGraph["nodes"][number]) => string | undefined) => [
    ...new Set(graph.nodes.map(pick).filter((x): x is string => !!x)),
  ];
  const data = <T extends keyof typeof nodeDataSchemas>(n: FlowGraph["nodes"][number], t: T) =>
    n.type === t
      ? (nodeDataSchemas[t].safeParse(n.data).data as Record<string, unknown> | undefined)
      : undefined;

  const templateIds = ids((n) => data(n, "template")?.templateId as string | undefined);
  const flowIds = ids((n) => data(n, "run_flow")?.flowId as string | undefined);
  const userIds = ids(
    (n) =>
      (data(n, "assign_to")?.userId ??
        data(n, "send_notification")?.userId ??
        data(n, "add_task")?.assigneeId) as string | undefined,
  );
  const teamIds = ids((n) => data(n, "assign_to")?.teamId as string | undefined);
  const pipelineIds = ids((n) => data(n, "enquiry")?.pipelineId as string | undefined);
  const stageIds = ids((n) => data(n, "enquiry")?.stageId as string | undefined);

  const [tpl, flows, users, teams, pipelines, stages] = await Promise.all([
    templateIds.length
      ? admin
          .from("wa_templates")
          .select("id, name, status")
          .eq("org_id", orgId)
          .in("id", templateIds)
      : { data: [] },
    flowIds.length
      ? admin.from("flows").select("id").eq("org_id", orgId).in("id", flowIds)
      : { data: [] },
    userIds.length
      ? admin
          .from("memberships")
          .select("user_id")
          .eq("org_id", orgId)
          .eq("status", "active")
          .in("user_id", userIds)
      : { data: [] },
    teamIds.length
      ? admin.from("teams").select("id").eq("org_id", orgId).in("id", teamIds)
      : { data: [] },
    pipelineIds.length
      ? admin.from("pipelines").select("id").eq("org_id", orgId).in("id", pipelineIds)
      : { data: [] },
    stageIds.length
      ? admin.from("stages").select("id").eq("org_id", orgId).in("id", stageIds)
      : { data: [] },
  ]);
  const have = (rows: { data: unknown[] | null }, key: string) =>
    new Set((rows.data ?? []).map((r) => (r as Record<string, string>)[key]));
  const tplById = new Map(
    ((tpl.data ?? []) as Array<{ id: string; name: string; status: string }>).map((t) => [t.id, t]),
  );
  const flowSet = have(flows, "id");
  const userSet = have(users, "user_id");
  const teamSet = have(teams, "id");
  const pipelineSet = have(pipelines, "id");
  const stageSet = have(stages, "id");

  for (const n of graph.nodes) {
    const d = n.data as Record<string, unknown>;
    if (n.type === "template") {
      const t = tplById.get(String(d.templateId));
      if (!t) err(n.id, "The template no longer exists.");
      else if (t.status !== "APPROVED")
        warn(n.id, `Template "${t.name}" is ${t.status}; it cannot be sent until it is approved.`);
    }
    if (n.type === "run_flow") {
      if (d.flowId === flowId) err(n.id, "A flow cannot hand over to itself.");
      else if (!flowSet.has(String(d.flowId))) err(n.id, "The flow to run no longer exists.");
    }
    if (n.type === "assign_to") {
      if (d.userId && !userSet.has(String(d.userId)))
        err(n.id, "The person to assign to is not an active member.");
      if (d.teamId && !teamSet.has(String(d.teamId)))
        err(n.id, "The team to assign to no longer exists.");
    }
    if (n.type === "send_notification" && d.userId && !userSet.has(String(d.userId)))
      err(n.id, "The person to notify is not an active member.");
    if (n.type === "add_task" && d.assigneeId && !userSet.has(String(d.assigneeId)))
      err(n.id, "The task assignee is not an active member.");
    if (n.type === "enquiry") {
      if (d.pipelineId && !pipelineSet.has(String(d.pipelineId)))
        err(n.id, "The pipeline no longer exists.");
      if (d.stageId && !stageSet.has(String(d.stageId))) err(n.id, "The stage no longer exists.");
    }
    if (n.type === "portal_record") {
      const def = getPortalObject(String(d.objectKey));
      if (!def) err(n.id, `Unknown portal object "${String(d.objectKey)}".`);
      else if (!def.writePerm) err(n.id, `${def.label} is read-only.`);
      else if (!can(member, def.writePerm))
        err(n.id, `You cannot edit ${def.label}, so you cannot publish a flow that does.`);
    }
  }
  return issues;
}

export type PublishResult =
  | { ok: true; version: number; warnings: GraphIssue[] }
  | { ok: false; error: string; issues?: GraphIssue[] };

export async function publishFlow(
  admin: AdminClient,
  member: MemberLike,
  flowId: string,
): Promise<PublishResult> {
  const { data: flow } = await admin
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) return { ok: false, error: "Flow not found." };
  const f = flow as FlowRow;

  const { data: vars } = await admin
    .from("flow_variables")
    .select("key")
    .eq("org_id", member.orgId);
  const checked = validateGraph(f.draft_graph, {
    triggerType: f.trigger_type as TriggerType,
    triggerConfig: f.trigger_config as TriggerConfig,
    knownVariables: (vars ?? []).map((v) => v.key),
  });
  if (!checked.ok || !checked.graph) {
    return {
      ok: false,
      error: "Fix the problems listed before publishing.",
      issues: checked.issues,
    };
  }
  const refs = await checkReferences(admin, member.orgId, f.id, checked.graph, member);
  const issues = [...checked.issues, ...refs];
  if (refs.some((i) => i.severity === "error"))
    return { ok: false, error: "Fix the problems listed before publishing.", issues };

  const version = f.version + 1;
  const { error: vErr } = await admin.from("flow_versions").insert({
    org_id: member.orgId,
    flow_id: f.id,
    version,
    graph: checked.graph as unknown as NonNullable<Json>,
    published_by: member.userId,
  });
  if (vErr)
    return {
      ok: false,
      error:
        vErr.code === "23505"
          ? "Someone else just published this flow; reload and try again."
          : "Could not publish.",
    };

  const { data: updated, error } = await admin
    .from("flows")
    .update({
      version,
      status: f.status === "paused" ? "paused" : "active",
      published_at: new Date().toISOString(),
      published_by: member.userId,
    })
    .eq("id", f.id)
    .eq("org_id", member.orgId)
    .eq("version", f.version)
    .select("id");
  if (error || !updated?.length)
    return { ok: false, error: "Someone else just changed this flow; reload and try again." };
  return { ok: true, version, warnings: issues.filter((i) => i.severity === "warning") };
}
