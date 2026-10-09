"use client";

import "@xyflow/react/dist/style.css";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import {
  ArrowLeft,
  Copy,
  Loader2,
  Pause,
  Play,
  Redo2,
  Rocket,
  Save,
  ScrollText,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NODE_DEFS,
  NODE_GROUPS,
  defFor,
  outputsFor,
  searchNodes,
  type NodeDef,
} from "@/lib/flow-engine/catalog";
import { hasErrors, validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import type { FlowGraph, NodeType } from "@/lib/flow-engine/types";

import { publishFlow, saveFlowDraft, setFlowStatus } from "../actions";
import { FlowCanvasNode, type CanvasNodeData } from "./builder-node";
import { NodeForm } from "./node-form";
import { TriggerForm, type TriggerState } from "./trigger-form";
import { useHistory } from "./use-history";

export type BuilderLookups = {
  channels: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string; status: string; category: string }>;
  teams: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  flows: Array<{ id: string; name: string; published: boolean }>;
  segments: Array<{ id: string; name: string }>;
  variables: string[];
};

export type BuilderFlow = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "active" | "paused";
  version: number;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  has_webhook_token: boolean;
  channel_id: string | null;
  graph: FlowGraph;
  published_graph: FlowGraph | null;
};

type Snapshot = { nodes: Node[]; edges: Edge[]; meta: TriggerState };

const nodeTypes = { flowNode: FlowCanvasNode };
const TRIGGER_ID = "trigger";

function fromGraph(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "flowNode",
    position: n.position,
    deletable: n.type !== "trigger",
    data: { kind: n.type, config: n.data } satisfies CanvasNodeData,
  }));
  if (!nodes.some((n) => (n.data as CanvasNodeData).kind === "trigger")) {
    nodes.unshift({
      id: TRIGGER_ID,
      type: "flowNode",
      position: { x: 0, y: 0 },
      deletable: false,
      data: { kind: "trigger", config: {} } satisfies CanvasNodeData,
    });
  }
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? "default",
  }));
  return { nodes, edges };
}

function toGraph(nodes: Node[], edges: Edge[]): FlowGraph {
  return {
    nodes: nodes.map((n) => {
      const d = n.data as unknown as CanvasNodeData;
      return {
        id: n.id,
        type: d.kind as NodeType,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        data: d.config,
      };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? "default",
    })),
  };
}

const newId = (type: string) => `${type}_${Math.random().toString(36).slice(2, 7)}`;

export function FlowBuilder(props: { flow: BuilderFlow; lookups: BuilderLookups }) {
  return (
    <ReactFlowProvider>
      <Builder {...props} />
    </ReactFlowProvider>
  );
}

function Builder({ flow, lookups }: { flow: BuilderFlow; lookups: BuilderLookups }) {
  const router = useRouter();
  const rf = useReactFlow();
  const initial = useMemo(() => fromGraph(flow.graph), [flow.graph]);
  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [meta, setMeta] = useState<TriggerState>({
    name: flow.name,
    description: flow.description,
    trigger_type: flow.trigger_type,
    trigger_config: flow.trigger_config,
    channel_id: flow.channel_id,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const history = useHistory<Snapshot>();
  const burst = useRef<ReturnType<typeof setTimeout> | null>(null);

  const snapshot = useCallback((): Snapshot => ({ nodes, edges, meta }), [nodes, edges, meta]);
  const recordChange = useCallback(() => {
    history.record(snapshot());
    setDirty(true);
  }, [history, snapshot]);
  /** One history entry per burst of edits (typing in a field is one undo step, not one per keystroke). */
  const recordBurst = useCallback(() => {
    if (burst.current === null) history.record(snapshot());
    else clearTimeout(burst.current);
    burst.current = setTimeout(() => (burst.current = null), 800);
    setDirty(true);
  }, [history, snapshot]);

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const issues = useMemo<GraphIssue[]>(() => validateGraph(graph).issues, [graph]);
  const issueByNode = useMemo(() => {
    const m = new Map<string, "error" | "warning">();
    for (const i of issues) if (i.nodeId && m.get(i.nodeId) !== "error") m.set(i.nodeId, i.level);
    return m;
  }, [issues]);
  const canvasNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...(n.data as unknown as CanvasNodeData),
          triggerType: meta.trigger_type,
          issue: issueByNode.get(n.id),
        },
      })),
    [nodes, meta.trigger_type, issueByNode],
  );

  const apply = (s: Snapshot) => {
    setNodes(s.nodes);
    setEdges(s.edges);
    setMeta(s.meta);
    setDirty(true);
  };
  const undo = useCallback(() => {
    const prev = history.undo(snapshot());
    if (prev) apply(prev);
  }, [history, snapshot]);
  const redo = useCallback(() => {
    const next = history.redo(snapshot());
    if (next) apply(next);
  }, [history, snapshot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((ns) =>
        applyNodeChanges(
          changes.filter((c) => !(c.type === "remove" && c.id === TRIGGER_ID)),
          ns,
        ),
      ),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      recordChange();
      const handle = c.sourceHandle ?? "default";
      setEdges((es) => [
        ...es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? "default") === handle)),
        {
          id: `${c.source}-${handle}-${c.target}`,
          source: c.source!,
          target: c.target!,
          sourceHandle: handle,
        },
      ]);
    },
    [recordChange],
  );

  const addNode = useCallback(
    (def: NodeDef, at?: { x: number; y: number }) => {
      recordChange();
      const id = newId(def.type);
      const center =
        at ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: "flowNode",
          position: center,
          selected: true,
          data: { kind: def.type, config: structuredClone(def.defaults) } satisfies CanvasNodeData,
        },
      ]);
      setSelectedId(id);
    },
    [recordChange, rf],
  );

  const deleteNode = (id: string) => {
    if (id === TRIGGER_ID) return;
    recordChange();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  };

  const duplicateNode = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n || id === TRIGGER_ID) return;
    recordChange();
    const d = n.data as unknown as CanvasNodeData;
    const copy = newId(d.kind);
    setNodes((ns) => [
      ...ns.map((x) => ({ ...x, selected: false })),
      {
        ...n,
        id: copy,
        selected: true,
        position: { x: n.position.x + 40, y: n.position.y + 60 },
        data: { kind: d.kind, config: structuredClone(d.config) } satisfies CanvasNodeData,
      },
    ]);
    setSelectedId(copy);
  };

  const updateConfig = (id: string, next: Record<string, unknown>) => {
    recordBurst();
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id
          ? { ...n, data: { ...(n.data as unknown as CanvasNodeData), config: next } }
          : n,
      ),
    );
    // Questions: drop edges that pointed at options that no longer exist.
    const node = nodes.find((n) => n.id === id);
    if (node && (node.data as unknown as CanvasNodeData).kind === "question") {
      const valid = new Set(outputsFor("question", next).map((o) => o.id));
      setEdges((es) => es.filter((e) => e.source !== id || valid.has(e.sourceHandle ?? "default")));
    }
  };

  const updateMeta = (next: TriggerState) => {
    recordBurst();
    setMeta(next);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const selData = selected ? (selected.data as unknown as CanvasNodeData) : null;

  const persist = (then?: () => Promise<void>) =>
    startTransition(async () => {
      const r = await saveFlowDraft(flow.id, {
        name: meta.name,
        description: meta.description,
        trigger_type: meta.trigger_type as never,
        trigger_config: meta.trigger_config,
        channel_id: meta.channel_id,
        graph,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDirty(false);
      if (then) await then();
      else toast.success(r.message ?? "Saved.");
      router.refresh();
    });

  const publish = () =>
    persist(async () => {
      const r = await publishFlow(flow.id);
      if (r.ok) toast.success(r.message);
      else {
        toast.error(r.error);
        setDirty(true);
      }
    });

  const changeStatus = (status: "active" | "paused") =>
    startTransition(async () => {
      const r = await setFlowStatus(flow.id, status);
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
      router.refresh();
    });

  const palette = searchNodes(query);

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[34rem] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild aria-label="Back to flows">
          <Link href="/flows">
            <ArrowLeft />
          </Link>
        </Button>
        <h2 className="min-w-0 truncate text-lg font-semibold">{meta.name || "Untitled flow"}</h2>
        <Badge variant="secondary">
          {flow.status === "active" ? "Active" : flow.status === "paused" ? "Paused" : "Draft"}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {flow.version > 0 ? `v${flow.version} published` : "Never published"}
        </span>
        {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            disabled={!history.canUndo}
            onClick={undo}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!history.canRedo}
            onClick={redo}
          >
            <Redo2 />
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/flows/${flow.id}/logs`}>
              <ScrollText /> Logs
            </Link>
          </Button>
          {flow.status === "active" && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => changeStatus("paused")}
            >
              <Pause /> Pause
            </Button>
          )}
          {flow.status === "paused" && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => changeStatus("active")}
            >
              <Play /> Resume
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !dirty}
            onClick={() => persist()}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Save />} Save draft
          </Button>
          <Button
            size="sm"
            disabled={pending || hasErrors(issues)}
            title={hasErrors(issues) ? "Fix the errors first" : undefined}
            onClick={publish}
          >
            <Rocket /> Publish
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[14rem_1fr_21rem] gap-3">
        <aside
          className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-xl border p-2"
          aria-label="Node palette"
        >
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2 top-2.5 size-4" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search nodes"
              aria-label="Search nodes"
              className="pl-8"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {palette.length === 0 && (
              <p className="text-muted-foreground p-2 text-sm">No node matches “{query}”.</p>
            )}
            {NODE_GROUPS.map((g) => {
              const items = palette.filter((d) => d.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="mb-2">
                  <div className="text-muted-foreground px-1 py-1 text-[11px] font-semibold uppercase tracking-wide">
                    {g}
                  </div>
                  {items.map((d) => (
                    <button
                      key={d.type}
                      type="button"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("application/x-flow-node", d.type)}
                      onClick={() => addNode(d)}
                      className="hover:bg-accent w-full rounded-md px-2 py-1.5 text-left text-sm"
                      title={d.description}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </aside>

        <div
          className="min-h-0 overflow-hidden rounded-xl border"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData("application/x-flow-node");
            const def = NODE_DEFS.find((d) => d.type === type);
            if (def) addNode(def, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
        >
          <ReactFlow
            nodes={canvasNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={() => recordChange()}
            onBeforeDelete={async () => {
              recordChange();
              return true;
            }}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
            minZoom={0.2}
            maxZoom={1.75}
            deleteKeyCode={["Backspace", "Delete"]}
            colorMode="system"
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden md:!block" />
          </ReactFlow>
        </div>

        <aside
          className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border p-3"
          aria-label="Properties"
        >
          {selected && selData && selData.kind !== "trigger" ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{defFor(selData.kind)?.label ?? selData.kind}</h3>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Duplicate node"
                    onClick={() => duplicateNode(selected.id)}
                  >
                    <Copy />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete node"
                    onClick={() => deleteNode(selected.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <p className="text-muted-foreground text-xs">{defFor(selData.kind)?.description}</p>
              <NodeForm
                type={selData.kind as NodeType}
                config={selData.config}
                onChange={(next) => updateConfig(selected.id, next)}
                lookups={lookups}
              />
            </>
          ) : (
            <>
              <h3 className="font-semibold">{selected ? "Trigger" : "Flow settings"}</h3>
              <TriggerForm
                flowId={flow.id}
                state={meta}
                onChange={updateMeta}
                lookups={lookups}
                hasToken={flow.has_webhook_token}
              />
              {flow.status === "active" && (
                <p className="text-muted-foreground text-xs">
                  Trigger settings apply as soon as you save. Changes to the steps only apply after
                  you publish.
                </p>
              )}
            </>
          )}

          <div className="mt-auto border-t pt-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Checks
            </h4>
            {issues.length === 0 ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">No problems found.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {issues.map((i, k) => (
                  <li key={k}>
                    <button
                      type="button"
                      className={`w-full text-left text-xs hover:underline ${i.level === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"}`}
                      onClick={() =>
                        i.nodeId &&
                        (setSelectedId(i.nodeId),
                        rf.fitView({ nodes: [{ id: i.nodeId }], duration: 300, maxZoom: 1 }))
                      }
                    >
                      {i.level === "error" ? "Error: " : "Note: "}
                      {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
