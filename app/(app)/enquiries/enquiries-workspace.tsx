"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  ColumnSizingState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import {
  Bookmark,
  Download,
  Filter as FilterIcon,
  KanbanSquare,
  Plus,
  Search,
  Settings2,
  Table2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DataGrid } from "@/components/data-grid/data-grid";
import type { OptionSources } from "@/components/filter-builder/filter-builder";
import { FilterPanel } from "@/components/filter-builder/filter-panel";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createClient } from "@/lib/supabase/client";
import { CARD_FIELD_OPTIONS } from "@/lib/enquiries/constants";
import type { EnquiryRow } from "@/lib/enquiries/query";
import type { EnquiryViewSummary, PipelineInfo } from "@/lib/enquiries/server";
import { isScope, type EnquiryScope } from "@/lib/enquiries/views";
import { countConditions, filterSchema, type Filter } from "@/lib/filters/ast";
import { cn } from "@/lib/utils";

import { saveGridPrefs, type GridPrefs } from "@/app/(app)/contacts/actions";
import {
  changeStage,
  deleteEnquiryView,
  getBoard,
  getBoardColumnPage,
  getContactOption,
  getPipelineCounts,
  listEnquiries,
  listMatchingEnquiryIds,
  previewEnquiryFilterCount,
  savePipelineCardFields,
  type BoardColumn,
  type ContactOption,
} from "./actions";
import { BulkBar } from "./bulk-bar";
import { buildEnquiryColumns } from "./enquiries-grid";
import { EnquiryDrawer } from "./enquiry-drawer";
import { EnquiryTasks } from "./enquiry-tasks";
import { KanbanBoard } from "./kanban-board";
import { NewEnquiryDialog, type NewEnquiryPreset } from "./new-enquiry-dialog";
import { PipelinesRail } from "./pipelines-rail";
import { SaveViewDialog } from "./save-view-dialog";
import type { EnquiriesBootstrap } from "./types";

const ALL = "all";
const SCOPES: Array<{ key: EnquiryScope; label: string }> = [
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

export function EnquiriesWorkspace({ bootstrap }: { bootstrap: EnquiriesBootstrap }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [pipelines, setPipelines] = React.useState<PipelineInfo[]>(bootstrap.pipelines);
  const live = pipelines.filter((p) => !p.archived);
  const defaultPipeline = live.find((p) => p.is_default) ?? live[0] ?? null;

  const scopeParam = params.get("scope");
  const scope: EnquiryScope = isScope(scopeParam) ? scopeParam : "open";
  const pipelineParam = params.get("pipeline");
  const pipelineId: string | typeof ALL | null =
    pipelineParam === ALL
      ? ALL
      : (live.find((p) => p.id === pipelineParam)?.id ?? defaultPipeline?.id ?? null);
  const pipeline =
    pipelineId && pipelineId !== ALL ? (live.find((p) => p.id === pipelineId) ?? null) : null;
  const modeParam = params.get("mode");
  const mode: "kanban" | "table" = !pipeline ? "table" : modeParam === "table" ? "table" : "kanban";
  const enquiryId = params.get("enquiry");
  const viewId = params.get("view");

  const [views, setViews] = React.useState<EnquiryViewSummary[]>(bootstrap.views);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [filter, setFilter] = React.useState<Filter | null>(null);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(bootstrap.gridPrefs?.pageSize ?? 100);
  const [rows, setRows] = React.useState<EnquiryRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [board, setBoard] = React.useState<BoardColumn[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState<string | null>(null);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [allMatchingIds, setAllMatchingIds] = React.useState<string[] | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [newDraft, setNewDraft] = React.useState<{ open: boolean; preset: NewEnquiryPreset }>({
    open: false,
    preset: {},
  });
  const [saveViewOpen, setSaveViewOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  // --- table column layout (persisted per user) --------------------------------
  const prefs = bootstrap.gridPrefs;
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() =>
    Object.fromEntries((prefs?.columns ?? []).filter((c) => c.hidden).map((c) => [c.id, false])),
  );
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>(() =>
    Object.fromEntries(
      (prefs?.columns ?? []).filter((c) => c.width).map((c) => [c.id, c.width as number]),
    ),
  );
  const [columnOrder, setColumnOrder] = React.useState<string[]>(() =>
    (prefs?.columns ?? []).map((c) => c.id),
  );
  const columns = React.useMemo(() => buildEnquiryColumns(bootstrap), [bootstrap]);

  React.useEffect(() => {
    if (prefs) return;
    setColumnVisibility(
      Object.fromEntries(
        columns
          .filter((c) => (c.meta as { defaultHidden?: boolean } | undefined)?.defaultHidden)
          .map((c) => [c.id, false]),
      ),
    );
  }, [columns, prefs]);

  const layoutReady = React.useRef(false);
  React.useEffect(() => {
    if (!layoutReady.current) {
      layoutReady.current = true;
      return;
    }
    const handle = setTimeout(() => {
      const ordered = columnOrder.length ? columnOrder : columns.map((c) => c.id);
      const next: GridPrefs = {
        columns: ordered.map((id) => ({
          id,
          width: columnSizing[id],
          hidden: columnVisibility[id] === false,
        })),
        pageSize,
      };
      void saveGridPrefs("enquiries", next);
    }, 800);
    return () => clearTimeout(handle);
  }, [columnVisibility, columnSizing, columnOrder, pageSize, columns]);

  React.useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
    setRowSelection({});
    setAllMatchingIds(null);
  }, [pipelineId, scope, filter, debouncedSearch, sorting, pageSize, mode]);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  function setParam(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const sort = React.useMemo(
    () =>
      sorting
        .map((s) => {
          const col = columns.find((c) => c.id === s.id);
          return col?.sortKey
            ? { field: col.sortKey, dir: s.desc ? ("desc" as const) : ("asc" as const) }
            : null;
        })
        .filter((s): s is { field: string; dir: "asc" | "desc" } => !!s),
    [sorting, columns],
  );

  const listInput = React.useMemo(
    () => ({
      scope,
      pipelineId: pipeline?.id ?? null,
      filter,
      search: debouncedSearch || null,
      sort,
      page,
      pageSize,
    }),
    [scope, pipeline?.id, filter, debouncedSearch, sort, page, pageSize],
  );

  // --- data ---------------------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (mode === "kanban" && pipeline) {
      getBoard({ scope, pipelineId: pipeline.id, filter, search: debouncedSearch || null }).then(
        (res) => {
          if (cancelled) return;
          setLoading(false);
          if (!res.ok) return void toast.error(res.error);
          setBoard(res.data.columns);
        },
      );
    } else {
      listEnquiries(listInput).then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (!res.ok) return void toast.error(res.error);
        setRows(res.data.rows);
        setTotal(res.data.total);
      });
    }
    return () => {
      cancelled = true;
    };
    // listInput already captures scope / pipeline / filter / search / paging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, listInput, reloadKey]);

  React.useEffect(() => {
    let cancelled = false;
    getPipelineCounts(scope).then((res) => {
      if (!cancelled && res.ok) setCounts(res.data.counts);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadKey]);

  // Realtime: other people's changes refresh the board (debounced).
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`enquiries:${bootstrap.orgId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "enquiries",
          filter: `org_id=eq.${bootstrap.orgId}`,
        },
        () => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(reload, 500);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bootstrap.orgId, reload]);

  // "Create enquiry" from the inbox / a contact: /enquiries?new=1&contact=<id>
  const handledNew = React.useRef(false);
  React.useEffect(() => {
    if (handledNew.current || params.get("new") !== "1" || !bootstrap.can.manage) return;
    handledNew.current = true;
    const contactId = params.get("contact");
    const channelId = params.get("channel");
    void (async () => {
      let contact: ContactOption | null = null;
      if (contactId) {
        const res = await getContactOption(contactId);
        if (res.ok) contact = res.data.contact;
      }
      setNewDraft({ open: true, preset: { contact, channelId, pipelineId: pipeline?.id ?? null } });
      setParam({ new: null, contact: null, channel: null });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // --- kanban actions -----------------------------------------------------------
  async function moveCard(id: string, toStageId: string) {
    const snapshot = board;
    setBoard((cols) => {
      const moving = cols.flatMap((c) => c.rows).find((r) => r.id === id);
      if (!moving) return cols;
      const moved = { ...moving, stage_id: toStageId, stage_entered_at: new Date().toISOString() };
      return cols.map((c) => {
        if (c.stageId === moving.stage_id)
          return { ...c, total: Math.max(0, c.total - 1), rows: c.rows.filter((r) => r.id !== id) };
        if (c.stageId === toStageId) return { ...c, total: c.total + 1, rows: [moved, ...c.rows] };
        return c;
      });
    });
    const res = await changeStage(id, toStageId);
    if (!res.ok) {
      toast.error(res.error);
      setBoard(snapshot);
    }
    reload();
  }

  async function loadMore(stageId: string) {
    if (!pipeline) return;
    const col = board.find((c) => c.stageId === stageId);
    if (!col) return;
    setLoadingMore(stageId);
    const res = await getBoardColumnPage({
      scope,
      pipelineId: pipeline.id,
      filter,
      search: debouncedSearch || null,
      stageId,
      page: Math.floor(col.rows.length / 50) + 1,
    });
    setLoadingMore(null);
    if (!res.ok) return void toast.error(res.error);
    setBoard((cols) =>
      cols.map((c) => {
        if (c.stageId !== stageId) return c;
        const have = new Set(c.rows.map((r) => r.id));
        return { ...c, rows: [...c.rows, ...res.data.rows.filter((r) => !have.has(r.id))] };
      }),
    );
  }

  // --- selection / export -------------------------------------------------------
  const selectedIds = allMatchingIds ?? Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const activeConditions = filter
    ? countConditions(filter.include) + countConditions(filter.exclude ?? null)
    : 0;

  async function selectAllMatching() {
    const res = await listMatchingEnquiryIds({ ...listInput, page: 1, pageSize: 10 });
    if (!res.ok) return void toast.error(res.error);
    setAllMatchingIds(res.data.ids);
    setRowSelection(Object.fromEntries(rows.map((r) => [r.id, true])));
  }

  async function exportCsv(ids?: string[]) {
    const res = await fetch("/api/enquiries/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        ids
          ? { ids }
          : { scope, pipelineId: pipeline?.id ?? null, filter, search: debouncedSearch || null },
      ),
    });
    if (!res.ok) {
      toast.error(
        res.status === 403 ? "You do not have permission to export enquiries." : "Export failed.",
      );
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `enquiries-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- views --------------------------------------------------------------------
  function applyView(v: EnquiryViewSummary) {
    const parsed = filterSchema.safeParse(v.filter);
    setFilter(
      parsed.success &&
        countConditions(parsed.data.include) + countConditions(parsed.data.exclude ?? null) > 0
        ? parsed.data
        : null,
    );
    if (v.mode === "table" && v.columns.length) {
      const known = new Set(columns.map((c) => c.id));
      setColumnVisibility(
        Object.fromEntries(
          columns.filter((c) => !c.locked && !v.columns.includes(c.id)).map((c) => [c.id, false]),
        ),
      );
      setColumnOrder([
        ...v.columns.filter((id) => known.has(id)),
        ...columns.map((c) => c.id).filter((id) => !v.columns.includes(id)),
      ]);
    }
    setParam({ view: v.id, pipeline: v.pipeline_id ?? ALL, mode: v.mode, scope: null });
  }

  async function removeView(v: EnquiryViewSummary) {
    if (!confirm(`Delete the view “${v.name}”?`)) return;
    const res = await deleteEnquiryView(v.id);
    if (!res.ok) return void toast.error(res.error);
    setViews((prev) => prev.filter((x) => x.id !== v.id));
    if (viewId === v.id) setParam({ view: null });
  }

  const visibleColumnIds = (columnOrder.length ? columnOrder : columns.map((c) => c.id)).filter(
    (id) => columnVisibility[id] !== false,
  );

  const optionSources: OptionSources = React.useMemo(
    () => ({
      users: bootstrap.users.map((u) => ({ value: u.id, label: u.label })),
      channels: bootstrap.lookups.channels.map((c) => ({ value: c.id, label: c.name })),
      locations: bootstrap.lookups.locations.map((x) => ({ value: x.id, label: x.name })),
      departments: bootstrap.lookups.departments.map((x) => ({ value: x.id, label: x.name })),
      specialists: bootstrap.lookups.specialists.map((x) => ({ value: x.id, label: x.name })),
      services: bootstrap.lookups.services.map((x) => ({ value: x.id, label: x.name })),
      pipelines: pipelines.map((p) => ({ value: p.id, label: p.name })),
      stages: pipelines.flatMap((p) =>
        p.stages.map((s) => ({ value: s.id, label: `${p.name} · ${s.name}` })),
      ),
      sources: bootstrap.sources.map((s) => ({ value: s, label: s })),
    }),
    [bootstrap, pipelines],
  );

  const canSwitchToKanban = !!pipeline;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="Enquiries"
        description="Pipelines for everything between a first message and a booked patient."
      >
        {bootstrap.can.export && (
          <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
            <Download /> Export
          </Button>
        )}
        {bootstrap.can.manage && (
          <Button
            size="sm"
            disabled={live.length === 0}
            onClick={() =>
              setNewDraft({ open: true, preset: { pipelineId: pipeline?.id ?? null } })
            }
          >
            <Plus /> New enquiry
          </Button>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 gap-4">
        <PipelinesRail
          pipelines={pipelines}
          counts={counts}
          activePipelineId={pipelineId === ALL ? null : pipelineId}
          views={views}
          activeViewId={viewId}
          onSelectPipeline={(id) => setParam({ pipeline: id ?? ALL, view: null })}
          onSelectView={applyView}
          onDeleteView={(v) => void removeView(v)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Open or closed"
              className="bg-muted inline-flex rounded-lg p-0.5"
            >
              {SCOPES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={scope === s.key}
                  onClick={() => setParam({ scope: s.key === "open" ? null : s.key })}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm",
                    scope === s.key
                      ? "bg-background font-medium shadow-xs"
                      : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Layout" className="bg-muted inline-flex rounded-lg p-0.5">
              <button
                type="button"
                aria-pressed={mode === "kanban"}
                disabled={!canSwitchToKanban}
                title={canSwitchToKanban ? "Kanban" : "Pick a pipeline to use the Kanban view"}
                onClick={() => setParam({ mode: null })}
                className={cn(
                  "flex items-center gap-1 rounded-md px-3 py-1 text-sm disabled:opacity-50",
                  mode === "kanban"
                    ? "bg-background font-medium shadow-xs"
                    : "text-muted-foreground",
                )}
              >
                <KanbanSquare className="size-4" /> Kanban
              </button>
              <button
                type="button"
                aria-pressed={mode === "table"}
                onClick={() => setParam({ mode: "table" })}
                className={cn(
                  "flex items-center gap-1 rounded-md px-3 py-1 text-sm",
                  mode === "table"
                    ? "bg-background font-medium shadow-xs"
                    : "text-muted-foreground",
                )}
              >
                <Table2 className="size-4" /> Table
              </button>
            </div>
            <div className="relative w-64 max-w-full">
              <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ID, title, name, phone"
                className="h-9 pl-8"
                aria-label="Search enquiries"
              />
              {search && (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="text-muted-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  onClick={() => setSearch("")}
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            <Button
              variant={activeConditions ? "secondary" : "outline"}
              size="sm"
              onClick={() => setFilterOpen(true)}
            >
              <FilterIcon /> Filters
              {activeConditions > 0 && <Badge variant="default">{activeConditions}</Badge>}
            </Button>
            {activeConditions > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setFilter(null)}>
                <X /> Clear
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setSaveViewOpen(true)}>
              <Bookmark /> Save view
            </Button>
            {mode === "kanban" && pipeline && bootstrap.can.settings && (
              <CardFieldsPopover
                pipeline={pipeline}
                onSaved={(fields) =>
                  setPipelines((prev) =>
                    prev.map((p) => (p.id === pipeline.id ? { ...p, card_fields: fields } : p)),
                  )
                }
              />
            )}
          </div>

          {mode === "table" && selectedIds.length > 0 && bootstrap.can.manage && (
            <BulkBar
              ids={selectedIds}
              pageCount={rows.length}
              total={total}
              allSelected={allMatchingIds !== null}
              onSelectAll={selectAllMatching}
              onClear={() => {
                setRowSelection({});
                setAllMatchingIds(null);
              }}
              bootstrap={bootstrap}
              pipeline={pipeline}
              onExport={() => void exportCsv(selectedIds)}
              onDone={() => {
                setRowSelection({});
                setAllMatchingIds(null);
                reload();
              }}
            />
          )}

          {mode === "kanban" && pipeline ? (
            <KanbanBoard
              pipeline={pipeline}
              columns={board}
              bootstrap={bootstrap}
              loading={loading}
              loadingMoreStage={loadingMore}
              onMove={(id, stage) => void moveCard(id, stage)}
              onOpen={(id) => setParam({ enquiry: id })}
              onAdd={(stageId) =>
                setNewDraft({ open: true, preset: { pipelineId: pipeline.id, stageId } })
              }
              onLoadMore={(stageId) => void loadMore(stageId)}
            />
          ) : (
            <DataGrid
              columns={columns}
              data={rows}
              loading={loading}
              total={total}
              page={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              sorting={sorting}
              onSortingChange={setSorting}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
              columnSizing={columnSizing}
              onColumnSizingChange={setColumnSizing}
              columnOrder={columnOrder}
              onColumnOrderChange={setColumnOrder}
              rowSelection={rowSelection}
              onRowSelectionChange={(u) => {
                setAllMatchingIds(null);
                setRowSelection(u);
              }}
              onRowClick={(r) => setParam({ enquiry: r.id })}
              emptyText={
                total === 0 && !activeConditions && !debouncedSearch
                  ? "No enquiries here yet."
                  : "No enquiries match."
              }
            />
          )}
        </div>
      </div>

      <FilterPanel
        open={filterOpen}
        onOpenChange={setFilterOpen}
        value={filter}
        onApply={setFilter}
        fields={bootstrap.fields}
        options={optionSources}
        previewCount={async (f) => {
          const res = await previewEnquiryFilterCount(f, scope, pipeline?.id ?? null);
          return res.ok ? { count: res.data.count } : { error: res.error };
        }}
      />

      <SaveViewDialog
        open={saveViewOpen}
        onOpenChange={setSaveViewOpen}
        bootstrap={bootstrap}
        draft={{
          pipelineId: pipeline?.id ?? null,
          mode,
          filter,
          columns: mode === "table" ? visibleColumnIds : [],
        }}
        onSaved={() => router.refresh()}
      />

      {bootstrap.can.manage && (
        <NewEnquiryDialog
          open={newDraft.open}
          onOpenChange={(o) => setNewDraft((d) => ({ ...d, open: o }))}
          bootstrap={bootstrap}
          preset={newDraft.preset}
          onCreated={(id) => {
            reload();
            setParam({ enquiry: id });
          }}
        />
      )}

      <EnquiryDrawer
        enquiryId={enquiryId}
        onClose={() => setParam({ enquiry: null })}
        bootstrap={bootstrap}
        onChanged={reload}
        tasksTab={(detail, load) => (
          <EnquiryTasks detail={detail} bootstrap={bootstrap} reload={load} />
        )}
      />
    </div>
  );
}

function CardFieldsPopover({
  pipeline,
  onSaved,
}: {
  pipeline: PipelineInfo;
  onSaved: (fields: string[]) => void;
}) {
  const [fields, setFields] = React.useState<string[]>(pipeline.card_fields);
  const [pending, startTransition] = React.useTransition();
  React.useEffect(() => setFields(pipeline.card_fields), [pipeline.id, pipeline.card_fields]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 /> Card fields
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="mb-2 text-sm font-medium">Show on {pipeline.name} cards</p>
        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {CARD_FIELD_OPTIONS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={fields.includes(f.key)}
                onCheckedChange={(c) =>
                  setFields((cur) => (c ? [...cur, f.key] : cur.filter((x) => x !== f.key)))
                }
              />
              {f.label}
            </label>
          ))}
        </div>
        <Button
          size="sm"
          className="mt-3 w-full"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await savePipelineCardFields(pipeline.id, fields);
              if (!res.ok) return void toast.error(res.error);
              toast.success(res.message ?? "Saved.");
              onSaved(fields);
            })
          }
        >
          Save
        </Button>
      </PopoverContent>
    </Popover>
  );
}
