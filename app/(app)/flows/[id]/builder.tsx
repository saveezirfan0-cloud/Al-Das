"use client";

import "@xyflow/react/dist/style.css";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Plus,
  Redo2,
  ScrollText,
  Search,
  Settings2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { validateGraph, type GraphIssue } from "@/lib/flow-engine/graph";
import {
  NODE_META,
  NODE_TYPES,
  handlesFor,
  type FlowGraph,
  type NodeType,
  type TriggerConfig,
  type TriggerType,
} from "@/lib/flow-engine/types";
import { cn } from "@/lib/utils";

import { publishFlowAction, saveFlowDraft, setFlowStatus } from "../actions";
import { FlowNodeCard, NODE_ICON, toneFor, type CardExtras } from "./node-card";
import {
  defaultConfig,
  fromCanvas,
  newNodeId,
  pruneEdges,
  toCanvas,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
} from "./graph-model";
import type { BuilderLookups } from "./lookups";
import { NodeForm } from "./node-forms";
import { SettingsDialog, type FlowSettings } from "./settings-dialog";

const nodeTypes: NodeTypes = { flowNode: FlowNodeCard as unknown as NodeTypes[string] };
const HISTORY_LIMIT = 60;

export type BuilderFlow = {
  id: string;
  status: "draft" | "active" | "paused";
  version: number;
  graph: FlowGraph;
  settings: FlowSettings;
  hasWebhookToken: boolean;
  knownVariables: string[];
  unpublished: boolean;
};

export function FlowBuilder(props: { flow: BuilderFlow; lookups: BuilderLookups }) {
  return (
    <ReactFlowProvider>
      <Builder {...props} />
    </ReactFlowProvider>
  );
}

type SaveState = "saved" | "dirty" | "saving" | "error";

function Builder({ flow, lookups }: { flow: BuilderFlow; lookups: BuilderLookups }) {
  const router = useRouter();
  const rf = useReactFlow();
  const initial = React.useMemo(
    () =>
      toCanvas(
        flow.graph.nodes.length
          ? flow.graph
          : {
              nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} }],
              edges: [],
            },
      ),
    [flow.graph],
  );
  const [nodes, setNodes] = React.useState<CanvasNode[]>(initial.nodes);
  const [edges, setEdges] = React.useState<CanvasEdge[]>(initial.edges);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<FlowSettings>(flow.settings);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [status, setStatus] = React.useState(flow.status);
  const [version, setVersion] = React.useState(flow.version);
  const [published, setPublished] = React.useState(!flow.unpublished);
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [serverIssues, setServerIssues] = React.useState<GraphIssue[]>([]);
  const [busy, setBusy] = React.useState<null | "publish" | "status">(null);
  const [query, setQuery] = React.useState("");

  // --- history (undo / redo) -------------------------------------------------
  const history = React.useRef<string[]>([
    JSON.stringify(fromCanvas(initial.nodes, initial.edges)),
  ]);
  const cursor = React.useRef(0);
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const current = React.useRef({ nodes, edges });
  current.current = { nodes, edges };

  const snapshot = React.useCallback(() => {
    const key = JSON.stringify(fromCanvas(current.current.nodes, current.current.edges));
    if (history.current[cursor.current] === key) return;
    history.current = [...history.current.slice(0, cursor.current + 1), key].slice(-HISTORY_LIMIT);
    cursor.current = history.current.length - 1;
    force();
  }, []);

  const restore = (index: number) => {
    const g = JSON.parse(history.current[index]) as FlowGraph;
    const c = toCanvas(g);
    cursor.current = index;
    setNodes(c.nodes);
    setEdges(c.edges);
    setSelectedId((id) => (id && c.nodes.some((n) => n.id === id) ? id : null));
    force();
  };
  const undo = () => cursor.current > 0 && restore(cursor.current - 1);
  const redo = () => cursor.current < history.current.length - 1 && restore(cursor.current + 1);

  // --- validation ---------------------------------------------------------------
  const graph = React.useMemo(() => fromCanvas(nodes, edges), [nodes, edges]);
  const graphKey = React.useMemo(() => JSON.stringify(graph), [graph]);
  const checked = React.useMemo(
    () =>
      validateGraph(graph, {
        triggerType: settings.trigger_type,
        triggerConfig: settings.trigger_config,
        knownVariables: flow.knownVariables,
      }),
    [graph, settings.trigger_type, settings.trigger_config, flow.knownVariables],
  );
  const issues = React.useMemo(
    () => [
      ...checked.issues,
      ...serverIssues.filter(
        (s) => !checked.issues.some((c) => c.message === s.message && c.nodeId === s.nodeId),
      ),
    ],
    [checked.issues, serverIssues],
  );
  const issuesByNode = React.useMemo(() => {
    const m = new Map<string, GraphIssue[]>();
    for (const i of issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i]);
    return m;
  }, [issues]);
  const errorCount = issues.filter((i) => i.severity === "error").length;

  // --- autosave -----------------------------------------------------------------
  const lastSaved = React.useRef(graphKey);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveNow = React.useCallback(async (): Promise<boolean> => {
    if (lastSaved.current === graphKey) return true;
    setSaveState("saving");
    const key = graphKey;
    const r = await saveFlowDraft(flow.id, JSON.parse(key));
    if (!r.ok) {
      setSaveState("error");
      toast.error(r.error);
      return false;
    }
    lastSaved.current = key;
    setServerIssues([]); // the live checks above already cover everything a save can report
    setSaveState("saved");
    setPublished(false);
    return true;
  }, [flow.id, graphKey]);

  React.useEffect(() => {
    if (lastSaved.current === graphKey) return;
    setSaveState("dirty");
    saveTimer.current = setTimeout(() => void saveNow(), 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [graphKey, saveNow]);

  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  // --- canvas events ------------------------------------------------------------
  const onNodesChange = React.useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (changes.some((c) => c.type === "remove")) setTimeout(snapshot, 0);
      if (changes.some((c) => c.type === "position" && c.dragging === false))
        setTimeout(snapshot, 0);
    },
    [snapshot],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      setEdges((es) => applyEdgeChanges(changes, es));
      if (changes.some((c) => c.type === "remove")) setTimeout(snapshot, 0);
    },
    [snapshot],
  );

  const onConnect = React.useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      setEdges((es) => {
        const handle = c.sourceHandle || "default";
        const kept = es.filter(
          (e) => !(e.source === c.source && (e.sourceHandle || "default") === handle),
        );
        return addEdge({ ...c, sourceHandle: handle, type: "smoothstep" }, kept);
      });
      setTimeout(snapshot, 0);
    },
    [snapshot],
  );

  const isValidConnection = React.useCallback(
    (c: { source: string; target: string }) =>
      c.source !== c.target && nodes.find((n) => n.id === c.target)?.data.nodeType !== "trigger",
    [nodes],
  );

  const addNode = React.useCallback(
    (type: NodeType, position?: { x: number; y: number }) => {
      if (type === "trigger") return;
      const id = newNodeId(type, current.current.nodes);
      const pos =
        position ??
        rf.screenToFlowPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 80 });
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: "flowNode",
          position: pos,
          selected: true,
          data: { nodeType: type, config: defaultConfig(type) },
        },
      ]);
      setSelectedId(id);
      setTimeout(snapshot, 0);
    },
    [rf, snapshot],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/x-flow-node") as NodeType;
    if (!NODE_TYPES.includes(type)) return;
    addNode(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const configTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateConfig = (config: Record<string, unknown>) => {
    if (!selected) return;
    setNodes((ns) =>
      ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, config } } : n)),
    );
    setEdges((es) =>
      pruneEdges(
        current.current.nodes.map((n) =>
          n.id === selected.id ? { ...n, data: { ...n.data, config } } : n,
        ),
        es,
      ),
    );
    if (configTimer.current) clearTimeout(configTimer.current);
    configTimer.current = setTimeout(snapshot, 700);
  };
  const deleteSelected = () => {
    if (!selected || selected.data.nodeType === "trigger") return;
    setNodes((ns) => ns.filter((n) => n.id !== selected.id));
    setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
    setSelectedId(null);
    setTimeout(snapshot, 0);
  };

  // Keyboard: undo / redo.
  React.useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- publish / status -----------------------------------------------------------
  async function publish() {
    setBusy("publish");
    if (!(await saveNow())) return void setBusy(null);
    const r = await publishFlowAction(flow.id);
    setBusy(null);
    if (!r.ok) {
      setServerIssues(r.issues ?? []);
      return void toast.error(r.error);
    }
    setVersion(r.data.version);
    setPublished(true);
    if (status === "draft") setStatus("active");
    setServerIssues(r.data.warnings);
    toast.success(r.message ?? "Published.");
    router.refresh();
  }
  async function toggleStatus() {
    const next = status === "active" ? "paused" : "active";
    setBusy("status");
    const r = await setFlowStatus(flow.id, next);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    setStatus(next);
    toast.success(r.message);
  }

  const renderNodes = React.useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: { ...n.data, issues: issuesByNode.get(n.id) ?? [], lookups } as CanvasData &
          CardExtras,
      })),
    [nodes, issuesByNode, lookups],
  );

  const filtered = NODE_TYPES.filter(
    (t) =>
      t !== "trigger" &&
      `${NODE_META[t].label} ${NODE_META[t].description} ${NODE_META[t].group}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const groups = [...new Set(filtered.map((t) => NODE_META[t].group))];

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col md:-m-6">
      {/* top bar */}
      <div className="bg-background flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Back to flows">
          <Link href="/flows">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{settings.name}</h2>
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Badge
              variant={
                status === "active" ? "success" : status === "paused" ? "warning" : "outline"
              }
            >
              {status === "active" ? "Live" : status === "paused" ? "Paused" : "Draft"}
            </Badge>
            {version > 0 ? <span>v{version}</span> : null}
            {!published && version > 0 ? <span>· unpublished changes</span> : null}
            <span aria-live="polite">
              ·{" "}
              {saveState === "saving"
                ? "Saving…"
                : saveState === "dirty"
                  ? "Unsaved changes"
                  : saveState === "error"
                    ? "Could not save"
                    : "Draft saved"}
            </span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Undo"
            disabled={cursor.current === 0}
            onClick={undo}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Redo"
            disabled={cursor.current >= history.current.length - 1}
            onClick={redo}
          >
            <Redo2 className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="lg:hidden">
                <Plus className="size-4" />
                Add step
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              {NODE_TYPES.filter((t) => t !== "trigger").map((t) => (
                <DropdownMenuItem key={t} onSelect={() => addNode(t)}>
                  {NODE_META[t].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="size-4" />
            Trigger settings
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/flows/${flow.id}/logs`}>
              <ScrollText className="size-4" />
              Logs
            </Link>
          </Button>
          {version > 0 ? (
            <Button variant="outline" size="sm" onClick={toggleStatus} disabled={busy !== null}>
              {busy === "status" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : status === "active" ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              {status === "active" ? "Pause" : "Make live"}
            </Button>
          ) : null}
          <Button size="sm" onClick={publish} disabled={busy !== null || errorCount > 0}>
            {busy === "publish" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            Publish
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* palette */}
        <aside
          className="bg-background hidden w-56 shrink-0 flex-col border-r lg:flex"
          aria-label="Steps"
        >
          <div className="relative p-2">
            <Search className="text-muted-foreground absolute start-4 top-4 size-4" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search steps"
              className="ps-8"
              aria-label="Search steps"
            />
          </div>
          <ScrollArea className="flex-1">
            <div className="space-y-3 p-2 pt-0">
              {groups.map((g) => (
                <div key={g}>
                  <div className="text-muted-foreground px-1 pb-1 text-[11px] font-medium uppercase tracking-wide">
                    {g}
                  </div>
                  {filtered
                    .filter((t) => NODE_META[t].group === g)
                    .map((t) => {
                      const Icon = NODE_ICON[t];
                      return (
                        <button
                          key={t}
                          type="button"
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData("application/x-flow-node", t)}
                          onClick={() => addNode(t)}
                          className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm"
                          title={NODE_META[t].description}
                        >
                          <span
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded",
                              toneFor(t),
                            )}
                          >
                            <Icon className="size-3.5" />
                          </span>
                          <span className="truncate">{NODE_META[t].label}</span>
                        </button>
                      );
                    })}
                </div>
              ))}
              {groups.length === 0 ? (
                <p className="text-muted-foreground px-1 text-sm">No steps match.</p>
              ) : null}
            </div>
          </ScrollArea>
        </aside>

        {/* canvas */}
        <div
          className="relative min-h-[40vh] min-w-0 flex-1"
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          <ReactFlow
            nodes={renderNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection as never}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.6}
            deleteKeyCode={["Backspace", "Delete"]}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden lg:!block" />
          </ReactFlow>
          {nodes.length <= 1 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
              <div className="bg-background/90 text-muted-foreground rounded-md border px-3 py-1.5 text-sm shadow-sm">
                Drag a step onto the canvas, or click it in the list, then connect the trigger to
                it.
              </div>
            </div>
          ) : null}
        </div>

        {/* properties + problems */}
        <aside
          className="bg-background flex h-[45vh] w-full shrink-0 flex-col border-t lg:h-auto lg:w-80 lg:border-l lg:border-t-0"
          aria-label="Properties"
        >
          <ScrollArea className="flex-1">
            <div className="space-y-4 p-3">
              {selected ? (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {NODE_META[selected.data.nodeType].label}
                      </h3>
                      <p className="text-muted-foreground text-xs">
                        {NODE_META[selected.data.nodeType].description}
                      </p>
                    </div>
                    {selected.data.nodeType !== "trigger" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label="Delete step"
                        onClick={deleteSelected}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                  {(issuesByNode.get(selected.id) ?? []).map((i, k) => (
                    <Alert key={k} variant={i.severity === "error" ? "destructive" : "default"}>
                      <AlertDescription>{i.message}</AlertDescription>
                    </Alert>
                  ))}
                  <NodeForm
                    type={selected.data.nodeType}
                    data={selected.data.config}
                    onChange={updateConfig}
                    lookups={lookups}
                  />
                  <ExitsHint type={selected.data.nodeType} config={selected.data.config} />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">Select a step to edit it.</p>
              )}
            </div>
          </ScrollArea>
          <div className="max-h-56 shrink-0 overflow-y-auto border-t p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              {errorCount > 0 ? (
                <AlertTriangle className="text-destructive size-4" />
              ) : (
                <CheckCircle2 className="size-4 text-emerald-600" />
              )}
              {errorCount > 0
                ? `${errorCount} problem${errorCount > 1 ? "s" : ""} to fix`
                : issues.length
                  ? `Ready, ${issues.length} suggestion${issues.length > 1 ? "s" : ""}`
                  : "No problems found"}
            </div>
            <ul className="space-y-1">
              {issues.map((i, k) => (
                <li key={k}>
                  <button
                    type="button"
                    className={cn(
                      "hover:bg-accent w-full rounded px-1.5 py-1 text-start text-xs",
                      i.severity === "error" ? "text-destructive" : "text-muted-foreground",
                    )}
                    onClick={() =>
                      i.nodeId &&
                      (setSelectedId(i.nodeId),
                      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === i.nodeId }))))
                    }
                  >
                    {i.severity === "error" ? "● " : "○ "}
                    {i.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        flowId={flow.id}
        value={settings}
        lookups={lookups}
        hasWebhookToken={flow.hasWebhookToken}
        onSaved={(v) => (setSettings(v), setPublished(false))}
      />
    </div>
  );
}

function ExitsHint({ type, config }: { type: NodeType; config: Record<string, unknown> }) {
  const exits = handlesFor(type, config);
  if (exits.length < 2) return null;
  return (
    <p className="text-muted-foreground border-t pt-3 text-xs">
      Exits on the canvas: {exits.map((e) => e.replace("option:", "")).join(", ")}. Drag from an
      exit to the next step. An exit with no arrow ends the flow.
    </p>
  );
}

export type { TriggerConfig, TriggerType };
