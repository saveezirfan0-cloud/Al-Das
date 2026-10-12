/**
 * Flow Copilot output validation. PURE: takes the model's raw reply and either returns a flow that the existing engine
 * contracts accept, or a list of reasons it does not.
 *
 * The model's reply is untrusted input, exactly like a patient message. Nothing in it is executed or trusted:
 *   1. the reply is size-capped, then parsed as JSON (no repair by guessing);
 *   2. the shape, the number of nodes and edges, node ids and node types are checked against closed lists;
 *   3. node types that could move patient data somewhere or need ids the model cannot know (api_action and friends) are
 *      STRIPPED, with their edges bridged, and the draft says so;
 *   4. every node's settings are re-parsed with the engine's own schema (lib/flow-engine/node-schemas.ts) and rebuilt from
 *      the parsed result, so a key the schema does not know cannot ride along; choices only a person can make (template,
 *      team, who to notify) are blanked so the builder's Checks panel asks for them;
 *   5. loops, dangling edges, several triggers and unreachable nodes are removed or reported;
 *   6. the existing graph validator (lib/flow-engine/graph.ts) has the last word.
 *
 * Nothing here publishes or activates anything: the result is a DRAFT graph.
 */
import { z } from "zod";

import { extractJson } from "@/lib/ai/copilot/json";
import { clinicalContentFlags } from "@/lib/ai/guardrails";
import {
  AI_CONTACT_FIELDS,
  AI_FLOW_LIMITS,
  AI_NODE_TYPES,
  AI_TRIGGER_TYPES,
  STRIPPED_NODE_TYPES,
} from "@/lib/ai/flow-copilot/policy";
import { validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import { NODE_DATA_SCHEMAS } from "@/lib/flow-engine/node-schemas";
import {
  NODE_TYPES,
  triggerConditionsSchema,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type NodeType,
  type TriggerType,
} from "@/lib/flow-engine/types";

export type CopilotLookups = {
  /** Role names the "send notification" node may target by role. Anything else is left for a person to choose. */
  roleNames: readonly string[];
};

export type CopilotFlow = {
  name: string;
  description: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, unknown>;
  graph: FlowGraph;
};

/** Nodes that still need a person's choice. Drives the highlight in the builder. */
export type FlowNeeds = {
  templates: Array<{ nodeId: string; hint: string }>;
  teams: Array<{ nodeId: string; hint: string }>;
  people: Array<{ nodeId: string; hint: string }>;
};

export type FlowValidation =
  | { ok: true; flow: CopilotFlow; issues: GraphIssue[]; notes: string[]; needs: FlowNeeds }
  | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 15;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OPTION_ID_RE = /^[a-z0-9_]{1,40}$/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const PLACEHOLDER_ROOTS = ["contact", "vars", "steps", "trigger", "appointment"];

const rawNode = z.object({
  id: z.string().max(200),
  type: z.string().max(60),
  data: z.record(z.string(), z.unknown()).optional(),
});
const rawEdge = z.object({
  source: z.string().max(200),
  target: z.string().max(200),
  handle: z.string().max(80).nullish(),
  sourceHandle: z.string().max(80).nullish(),
});
const rawFlow = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  trigger: z
    .object({ type: z.string().max(60), config: z.record(z.string(), z.unknown()).optional() })
    .optional(),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
});

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.split("|")[0]!.trim());
}

type NodeResult = {
  data: Record<string, unknown>;
  errors: string[];
  notes: string[];
  need?: keyof FlowNeeds;
  hint?: string;
  /** User-visible text in this node, for the lints. */
  texts: string[];
};

function sanitiseNode(
  id: string,
  type: NodeType,
  raw: Record<string, unknown>,
  lookups: CopilotLookups,
): NodeResult {
  const out: NodeResult = { data: {}, errors: [], notes: [], texts: [] };
  const fail = (m: string) => out.errors.push(`Step "${id}" (${type}): ${m}`);
  const parse = <T extends NodeType>(t: T, input: unknown) => {
    const r = NODE_DATA_SCHEMAS[t].safeParse(input);
    if (!r.success) {
      const first = r.error.issues[0];
      fail(`${first?.path.join(".") || "settings"} ${first?.message ?? "are invalid"}`);
      return null;
    }
    return r.data as Record<string, unknown>;
  };

  switch (type) {
    case "trigger":
    case "end_flow":
    case "close_conversation":
      return out;
    case "message": {
      const text = clip(raw.text, AI_FLOW_LIMITS.maxMessageChars);
      if (!text) fail("needs message text");
      const d = parse(type, { text });
      if (d) out.data = d;
      out.texts.push(text);
      return out;
    }
    case "add_comment": {
      const text = clip(raw.text, AI_FLOW_LIMITS.maxCommentChars);
      if (!text) fail("needs note text");
      const d = parse(type, { text });
      if (d) out.data = d;
      out.texts.push(text);
      return out;
    }
    case "question": {
      const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 11).map((o) => {
        const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        const title = clip(r.title, 24);
        const rawId = clip(r.id, 40)
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "");
        return {
          id: OPTION_ID_RE.test(rawId)
            ? rawId
            : title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
                .slice(0, 40),
          title,
        };
      });
      const style =
        raw.style === "buttons" || raw.style === "list" || raw.style === "text"
          ? raw.style
          : options.length
            ? "buttons"
            : "text";
      const variable =
        typeof raw.variable === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.variable)
          ? raw.variable
          : undefined;
      const text = clip(raw.text, 1024);
      if (!text) fail("needs question text");
      const d = parse(type, {
        text,
        style,
        options: style === "text" ? [] : options,
        ...(variable ? { variable } : {}),
      });
      if (d) out.data = d;
      out.texts.push(text, ...options.map((o) => o.title));
      return out;
    }
    case "quick_reply": {
      const buttons = (Array.isArray(raw.buttons) ? raw.buttons : []).slice(0, 4).map((o) => {
        const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        const title = clip(r.title, 24);
        const rawId = clip(r.id, 40)
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "");
        return {
          id: OPTION_ID_RE.test(rawId)
            ? rawId
            : title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
                .slice(0, 40),
          title,
        };
      });
      const text = clip(raw.text, 1024);
      if (!text) fail("needs message text");
      const d = parse(type, { text, buttons });
      if (d) out.data = d;
      out.texts.push(text, ...buttons.map((b) => b.title));
      return out;
    }
    case "template": {
      // The model cannot know which approved template exists. A person chooses it; the hint says what it is for.
      out.data = { template_id: "", values: {} };
      out.need = "templates";
      out.hint = clip(raw.purpose ?? raw.hint, 120);
      return out;
    }
    case "assign_to": {
      const t = (raw.target && typeof raw.target === "object" ? raw.target : {}) as Record<
        string,
        unknown
      >;
      const kind =
        typeof t.type === "string" ? t.type : typeof raw.assign === "string" ? raw.assign : "team";
      if (kind === "bot" || kind === "unassign") out.data = { target: { type: kind } };
      else {
        out.data = { target: { type: "team", id: "" } };
        out.need = "teams";
        out.hint = clip(raw.purpose ?? raw.hint ?? t.name, 120);
      }
      return out;
    }
    case "send_notification": {
      const title = clip(raw.title, 120);
      if (!title) fail("needs a notification title");
      const body = clip(raw.body, 300);
      const t = (raw.target && typeof raw.target === "object" ? raw.target : {}) as Record<
        string,
        unknown
      >;
      const role = clip(t.id ?? t.role ?? raw.role, 60);
      const known = lookups.roleNames.find((r) => r.toLowerCase() === role.toLowerCase());
      out.data = { target: { type: "role", id: known ?? "" }, title, body };
      if (!known) {
        out.need = "people";
        out.hint = role ? `Wanted: ${role}` : "";
      }
      out.texts.push(title, body);
      return out;
    }
    case "wait": {
      const unit =
        raw.unit === "seconds" ||
        raw.unit === "minutes" ||
        raw.unit === "hours" ||
        raw.unit === "days"
          ? raw.unit
          : null;
      const amount = typeof raw.amount === "number" ? raw.amount : Number.NaN;
      if (!unit || !Number.isFinite(amount) || amount <= 0)
        fail("needs a positive amount and a unit (seconds, minutes, hours, days)");
      else {
        const days =
          amount * { seconds: 1 / 86_400, minutes: 1 / 1_440, hours: 1 / 24, days: 1 }[unit];
        if (days > AI_FLOW_LIMITS.maxWaitDays)
          fail(`waits longer than ${AI_FLOW_LIMITS.maxWaitDays} days are not allowed`);
        else {
          const d = parse(type, { amount, unit });
          if (d) out.data = d;
        }
      }
      return out;
    }
    case "office_hours": {
      const tz = clip(raw.timezone, 60) || "Asia/Dubai";
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
      } catch {
        fail("has an unknown timezone");
        return out;
      }
      const d = parse(type, { timezone: tz, schedule: raw.schedule ?? {} });
      if (d) out.data = d;
      return out;
    }
    case "branch": {
      const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
        .slice(0, 10)
        .map((c) => {
          const r = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
          return { left: clip(r.left, 120), op: r.op, right: clip(r.right, 200) };
        });
      for (const c of conditions) {
        if (!/^(vars|contact|trigger|steps)\.[A-Za-z0-9_.-]{1,100}$/.test(c.left)) {
          fail(
            `condition "${c.left.slice(0, 40)}" must read a value like vars.answer or contact.language`,
          );
        }
      }
      if (conditions.length === 0) fail("needs at least one condition");
      const d = parse(type, { logic: raw.logic === "or" ? "or" : "and", conditions });
      if (d) out.data = d;
      return out;
    }
    case "update_contact_field": {
      const field = clip(raw.field, 40);
      if (!(AI_CONTACT_FIELDS as readonly string[]).includes(field)) {
        fail(`may only set ${AI_CONTACT_FIELDS.join(" or ")} (a person decides the rest)`);
        return out;
      }
      const value = clip(raw.value, 100);
      const d = parse(type, { field, value });
      if (d) out.data = d;
      out.texts.push(value);
      return out;
    }
    default:
      fail("is not a step the copilot can create");
      return out;
  }
}

function sanitiseTriggerConfig(
  type: TriggerType,
  raw: Record<string, unknown>,
  errors: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (
    [
      "conversation_opened",
      "conversation_closed",
      "conversation_waiting",
      "template_button",
    ].includes(type)
  ) {
    const cond = triggerConditionsSchema.safeParse(raw.conditions ?? {});
    if (!cond.success)
      errors.push(
        "The trigger conditions are invalid (use source, keyword or ad with equals, not equals, contains or not contains).",
      );
    else out.conditions = cond.data;
  }
  if (type === "template_button") {
    const text = clip(raw.button_text, 40);
    if (text) out.button_text = text;
  }
  return out;
}

/** Removes `ids` from the graph, joining each incoming edge to the removed node's own next step (if it has one). */
function stripNodes(
  nodes: FlowNode[],
  edges: FlowEdge[],
  ids: ReadonlySet<string>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  let current = edges;
  for (const id of ids) {
    const incoming = current.filter((e) => e.target === id && e.source !== id);
    const outgoing = current.find(
      (e) => e.source === id && (e.sourceHandle ?? "default") === "default" && e.target !== id,
    );
    const rest = current.filter((e) => e.source !== id && e.target !== id);
    const bridged = outgoing
      ? incoming.map((e) => ({
          ...e,
          id: `${e.source}-${e.sourceHandle ?? "default"}-${outgoing.target}`,
          target: outgoing.target,
        }))
      : [];
    current = [...rest, ...bridged];
  }
  return { nodes: nodes.filter((n) => !ids.has(n.id)), edges: current };
}

function findCycle(nodes: FlowNode[], edges: FlowEdge[]): string | null {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const state = new Map<string, 1 | 2>();
  for (const n of nodes) {
    if (state.has(n.id)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: n.id, i: 0 }];
    state.set(n.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const kids = next.get(top.id) ?? [];
      if (top.i >= kids.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const k = kids[top.i++]!;
      const s = state.get(k);
      if (s === 1) return k;
      if (s === undefined) {
        state.set(k, 1);
        stack.push({ id: k, i: 0 });
      }
    }
  }
  return null;
}

/** Left-to-right layers from the trigger so the draft opens readable. Nodes the walk never reaches go in a last column. */
export function layoutGraph(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const trig = nodes.find((n) => n.type === "trigger");
  const depth = new Map<string, number>();
  if (trig) {
    depth.set(trig.id, 0);
    const queue = [trig.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges) {
        if (e.source === cur && !depth.has(e.target)) {
          depth.set(e.target, depth.get(cur)! + 1);
          queue.push(e.target);
        }
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const rows = new Map<number, number>();
  return nodes.map((n) => {
    const d = depth.get(n.id) ?? maxDepth + 1;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, position: { x: d * 320, y: row * 170 } };
  });
}

export function validateCopilotOutput(
  rawText: string,
  lookups: CopilotLookups = { roleNames: [] },
): FlowValidation {
  const parsedJson = extractJson(rawText, AI_FLOW_LIMITS.maxRawChars);
  if (!parsedJson.ok) return { ok: false, errors: [parsedJson.reason] };
  const shape = rawFlow.safeParse(parsedJson.value);
  if (!shape.success)
    return {
      ok: false,
      errors: ["The reply must be an object with a trigger, a nodes list and an edges list."],
    };
  const body = shape.data;

  if (body.nodes.length > AI_FLOW_LIMITS.maxNodes)
    return {
      ok: false,
      errors: [
        `The draft has ${body.nodes.length} steps. The limit is ${AI_FLOW_LIMITS.maxNodes}; make it shorter.`,
      ],
    };
  if (body.edges.length > AI_FLOW_LIMITS.maxEdges)
    return {
      ok: false,
      errors: [
        `The draft has ${body.edges.length} connections. The limit is ${AI_FLOW_LIMITS.maxEdges}.`,
      ],
    };

  const errors: string[] = [];
  const notes: string[] = [];
  const needs: FlowNeeds = { templates: [], teams: [], people: [] };
  const texts: Array<{ id: string; text: string }> = [];

  // --- trigger ---------------------------------------------------------------------------------------------------
  const wantedTrigger = body.trigger?.type ?? "";
  let triggerType: TriggerType = "shortcut";
  if (!wantedTrigger) errors.push("Choose a trigger type.");
  else if ((AI_TRIGGER_TYPES as readonly string[]).includes(wantedTrigger))
    triggerType = wantedTrigger as TriggerType;
  else
    errors.push(
      `Trigger "${wantedTrigger.slice(0, 40)}" is not allowed in a draft. Use one of: ${AI_TRIGGER_TYPES.join(", ")}.`,
    );
  const triggerConfig = sanitiseTriggerConfig(triggerType, body.trigger?.config ?? {}, errors);

  // --- nodes -----------------------------------------------------------------------------------------------------
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  const stripIds = new Set<string>();
  for (const candidate of body.nodes) {
    const parsed = rawNode.safeParse(candidate);
    if (!parsed.success) {
      errors.push("A step is missing its id or type.");
      continue;
    }
    const { id, type, data } = parsed.data;
    if (!ID_RE.test(id) || id.length > AI_FLOW_LIMITS.maxIdLength) {
      errors.push(
        `Step id "${id.slice(0, 40)}" is not allowed (letters, digits, - and _, starting with a letter, at most ${AI_FLOW_LIMITS.maxIdLength} characters).`,
      );
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Step id "${id}" is used twice.`);
      continue;
    }
    seen.add(id);
    if (!(NODE_TYPES as readonly string[]).includes(type)) {
      errors.push(`Step "${id}" has unknown type "${type.slice(0, 40)}".`);
      continue;
    }
    const nodeType = type as NodeType;
    if ((STRIPPED_NODE_TYPES as readonly NodeType[]).includes(nodeType)) {
      stripIds.add(id);
      notes.push(
        nodeType === "api_action"
          ? `Removed an "API action" step (${id}): drafts written by AI cannot call web addresses. Add one yourself if you need it.`
          : `Removed a "${nodeType}" step (${id}): add it yourself in the builder.`,
      );
      nodes.push({ id, type: nodeType, position: { x: 0, y: 0 }, data: {} });
      continue;
    }
    if (!(AI_NODE_TYPES as readonly NodeType[]).includes(nodeType)) {
      errors.push(`Step "${id}" has type "${type}" which the copilot does not create.`);
      continue;
    }
    const res = sanitiseNode(id, nodeType, data ?? {}, lookups);
    errors.push(...res.errors);
    notes.push(...res.notes);
    if (res.need) needs[res.need].push({ nodeId: id, hint: res.hint ?? "" });
    for (const t of res.texts) if (t) texts.push({ id, text: t });
    nodes.push({ id, type: nodeType, position: { x: 0, y: 0 }, data: res.data });
  }

  // --- edges -----------------------------------------------------------------------------------------------------
  const ids = new Set(nodes.map((n) => n.id));
  let edges: FlowEdge[] = [];
  const seenHandles = new Set<string>();
  for (const candidate of body.edges) {
    const parsed = rawEdge.safeParse(candidate);
    if (!parsed.success) {
      errors.push("A connection is missing its source or target.");
      continue;
    }
    const { source, target } = parsed.data;
    const handle = parsed.data.handle ?? parsed.data.sourceHandle ?? "default";
    if (!ids.has(source) || !ids.has(target)) {
      errors.push(
        `A connection ${source.slice(0, 40)} -> ${target.slice(0, 40)} points at a step that does not exist.`,
      );
      continue;
    }
    if (source === target) {
      errors.push(`Step "${source}" is connected to itself.`);
      continue;
    }
    const dup = `${source}:${handle}`;
    if (seenHandles.has(dup)) {
      errors.push(`Step "${source}" has two connections from its "${handle}" output.`);
      continue;
    }
    seenHandles.add(dup);
    edges.push({ id: `${source}-${handle}-${target}`, source, target, sourceHandle: handle });
  }

  // A question's choice outputs must be options it really has.
  for (const q of nodes.filter((n) => n.type === "question")) {
    const optionIds = new Set(
      ((q.data.options as Array<{ id: string }> | undefined) ?? []).map((o) => o.id),
    );
    for (const e of edges) {
      if (e.source !== q.id) continue;
      const h = e.sourceHandle ?? "default";
      if (h.startsWith("option:") && !optionIds.has(h.slice(7)))
        errors.push(
          `Step "${q.id}" has a connection for the option "${h.slice(7, 47)}" which it does not offer.`,
        );
    }
  }

  // --- strip policy-removed nodes, then anything the trigger cannot reach ------------------------------------------
  let kept = nodes;
  if (stripIds.size) ({ nodes: kept, edges } = stripNodes(nodes, edges, stripIds));

  const triggers = kept.filter((n) => n.type === "trigger");
  if (triggers.length === 1) {
    const reach = new Set<string>([triggers[0]!.id]);
    const queue = [triggers[0]!.id];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const e of edges) {
        if (e.source === cur && !reach.has(e.target)) {
          reach.add(e.target);
          queue.push(e.target);
        }
      }
    }
    const orphans = kept.filter((n) => !reach.has(n.id));
    if (orphans.length) {
      notes.push(
        `Removed ${orphans.length} step${orphans.length === 1 ? "" : "s"} that nothing led to.`,
      );
      const drop = new Set(orphans.map((n) => n.id));
      kept = kept.filter((n) => !drop.has(n.id));
      edges = edges.filter((e) => !drop.has(e.source) && !drop.has(e.target));
      for (const key of Object.keys(needs) as Array<keyof FlowNeeds>)
        needs[key] = needs[key].filter((n) => !drop.has(n.nodeId));
    }
  }
  for (const key of Object.keys(needs) as Array<keyof FlowNeeds>)
    needs[key] = needs[key].filter((n) => kept.some((k) => k.id === n.nodeId));

  const loop = findCycle(kept, edges);
  if (loop)
    errors.push(
      `The flow loops back to step "${loop}". Loops are not allowed in a draft; end each path instead.`,
    );

  // --- text lints -------------------------------------------------------------------------------------------------
  for (const { id, text } of texts) {
    if (!kept.some((k) => k.id === id)) continue;
    for (const flag of clinicalContentFlags(text))
      errors.push(
        `Step "${id}": ${flag} A bot message must not give medical advice, doses or diagnoses; hand the patient to staff instead.`,
      );
    if (URL_RE.test(text)) notes.push(`Step "${id}" contains a link. Check it before publishing.`);
    for (const p of placeholders(text)) {
      if (!PLACEHOLDER_ROOTS.includes(p.split(".")[0] ?? ""))
        notes.push(`Step "${id}" uses {${p.slice(0, 40)}}, which is not a known variable.`);
    }
  }

  // --- the engine's own validator has the last word ----------------------------------------------------------------
  const positioned = layoutGraph(kept, edges);
  const graph: FlowGraph = { nodes: positioned, edges };
  const checked = validateGraph(graph);
  if (!checked.graph) {
    errors.push(...checked.issues.map((i) => i.message));
  } else {
    for (const i of checked.issues) {
      if (i.level === "error" && i.kind !== "setup")
        errors.push(i.nodeId ? `Step "${i.nodeId}": ${i.message}.` : `${i.message}.`);
    }
  }

  if (errors.length) {
    const unique = [...new Set(errors)];
    return { ok: false, errors: unique.slice(0, MAX_REPORTED_ERRORS) };
  }

  const issues = checked.issues;
  return {
    ok: true,
    flow: {
      name: clip(body.name, 80) || "AI draft",
      description: clip(body.description, 300),
      triggerType,
      triggerConfig,
      graph,
    },
    issues,
    notes: [...new Set(notes)],
    needs,
  };
}
