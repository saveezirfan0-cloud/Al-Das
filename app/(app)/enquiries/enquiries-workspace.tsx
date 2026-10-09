"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  ColumnSizingState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import { Download, KanbanSquare, Plus, Search, Settings, Table2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { DataGrid } from "@/components/data-grid/data-grid";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { appendRows, moveCard } from "@/lib/enquiries/board";
import { EMPTY_FILTER, type EnquiryFilter } from "@/lib/enquiries/filter";
import type { BoardColumn, EnquiryRow } from "@/lib/enquiries/types";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { saveGridPrefs, type GridPrefs } from "../contacts/actions";
import { loadBoard, loadTable, moveStageAction } from "./actions";
import { BulkBar } from "./bulk-bar";
import { buildEnquiryColumns } from "./enquiries-table";
import { EnquiryDrawer } from "./enquiry-drawer";
import { activeFilterCount, FilterPopover } from "./filter-popover";
import { Kanban } from "./kanban";
import { NewEnquiryDialog } from "./new-enquiry-dialog";
import type { EnquiriesBootstrap, SavedView } from "./types";
import { ViewsMenu } from "./views-menu";

export function EnquiriesWorkspace({ bootstrap }: { bootstrap: EnquiriesBootstrap }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const pipelines = bootstrap.pipelines.filter((p) => !p.archived);
  const pipeline = pipelines.find((p) => p.id === params.get("pipeline")) ?? pipelines[0];
  const mode = params.get("mode") === "table" ? "table" : "board";
  const enquiryId = params.get("enquiry");

  const [filter, setFilter] = React.useState<EnquiryFilter>({ ...EMPTY_FILTER });
  const [viewId, setViewId] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [reloadKey, setReloadKey] = React.useState(0);
  const [newOpen, setNewOpen] = React.useState<{ open: boolean; stageId?: string }>({
    open: false,
  });

  // Board
  const [columns, setColumns] = React.useState<BoardColumn[]>([]);
  const [boardLoading, setBoardLoading] = React.useState(false);

  // Table
  const prefs = bootstrap.gridPrefs;
  const [rows, setRows] = React.useState<EnquiryRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [tableLoading, setTableLoading] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(prefs?.pageSize ?? 50);
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "created_at", desc: true }]);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
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

  const columnDefs = React.useMemo(
    () =>
      buildEnquiryColumns({ timezone: bootstrap.timezone, customFields: bootstrap.customFields }),
    [bootstrap.timezone, bootstrap.customFields],
  );

  // Hide the non-default columns the first time.
  React.useEffect(() => {
    if (prefs) return;
    setColumnVisibility(
      Object.fromEntries(
        columnDefs
          .filter((c) => (c.meta as { defaultHidden?: boolean } | undefined)?.defaultHidden)
          .map((c) => [c.id, false]),
      ),
    );
  }, [columnDefs, prefs]);

  // Persist the table layout (debounced), after the first render.
  const layoutReady = React.useRef(false);
  React.useEffect(() => {
    if (!layoutReady.current) {
      layoutReady.current = true;
      return;
    }
    const handle = setTimeout(() => {
      const ordered = columnOrder.length ? columnOrder : columnDefs.map((c) => c.id);
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
  }, [columnVisibility, columnSizing, columnOrder, pageSize, columnDefs]);

  // Debounced search into the filter.
  React.useEffect(() => {
    const handle = setTimeout(() => {
      setFilter((f) =>
        (f.search ?? "") === search.trim() ? f : { ...f, search: search.trim() || undefined },
      );
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const effective = React.useMemo<EnquiryFilter>(
    () => ({ ...filter, pipeline_id: pipeline?.id }),
    [filter, pipeline?.id],
  );
  const stageIds = React.useMemo(() => pipeline?.stages.map((s) => s.id) ?? [], [pipeline]);

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

  // Board data
  React.useEffect(() => {
    if (mode !== "board" || !pipeline || stageIds.length === 0) return;
    let cancelled = false;
    setBoardLoading(true);
    loadBoard({ filter: effective, stage_ids: stageIds }).then((r) => {
      if (cancelled) return;
      setBoardLoading(false);
      if (!r.ok) toast.error(r.error);
      else setColumns(r.columns);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, pipeline, stageIds, effective, reloadKey]);

  // Table data
  const sortCol = sorting[0] ? columnDefs.find((c) => c.id === sorting[0].id) : undefined;
  React.useEffect(() => {
    setPage(1);
    setRowSelection({});
  }, [effective, pageSize, sorting]);
  React.useEffect(() => {
    if (mode !== "table" || !pipeline) return;
    let cancelled = false;
    setTableLoading(true);
    loadTable({
      filter: effective,
      page,
      pageSize,
      sort: sortCol?.sortKey,
      dir: sorting[0]?.desc ? "desc" : "asc",
    }).then((r) => {
      if (cancelled) return;
      setTableLoading(false);
      if (!r.ok) toast.error(r.error);
      else {
        setRows(r.rows);
        setTotal(r.total);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mode, pipeline, effective, page, pageSize, sortCol?.sortKey, sorting, reloadKey]);

  // Realtime: refresh when enquiries change anywhere in the workspace.
  React.useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
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
          clearTimeout(timer);
          timer = setTimeout(reload, 800);
        },
      )
      .subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [bootstrap.orgId, reload]);

  function move(id: string, stageId: string) {
    const stage = pipeline?.stages.find((s) => s.id === stageId);
    if (!stage) return;
    const snapshot = columns;
    setColumns((prev) => moveCard(prev, id, stage));
    void moveStageAction(id, stageId).then((r) => {
      if (!r.ok) {
        toast.error(r.error);
        setColumns(snapshot);
      }
    });
  }

  async function showMore(stageId: string) {
    const col = columns.find((c) => c.stage_id === stageId);
    if (!col) return;
    const r = await loadBoard({
      filter: effective,
      stage_ids: [stageId],
      offsets: { [stageId]: col.rows.length },
    });
    if (!r.ok) toast.error(r.error);
    else
      setColumns((prev) =>
        appendRows(prev, stageId, r.columns[0]?.rows ?? [], r.columns[0]?.total ?? col.total),
      );
  }

  async function exportCsv(kind: "enquiries" | "activity") {
    const res = await fetch("/api/enquiries/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, filter: effective }),
    });
    if (!res.ok) {
      toast.error(
        res.status === 403
          ? "You do not have permission to export enquiries."
          : res.status === 429
            ? "Too many exports. Try again in a minute."
            : "Export failed.",
      );
      return;
    }
    if (res.headers.get("X-Export-Truncated") === "true")
      toast.warning(
        "Only the first 5,000 enquiries were exported. Narrow the filters to export the rest.",
      );
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `enquiries-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyView(v: SavedView | null) {
    setViewId(v?.id ?? null);
    setFilter(v ? { ...v.filter, pipeline_id: undefined } : { ...EMPTY_FILTER });
    setSearch(v?.filter.search ?? "");
    if (v?.pipeline_id && pipelines.some((p) => p.id === v.pipeline_id))
      setParam({ pipeline: v.pipeline_id });
  }

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const filterCount = activeFilterCount(filter);

  if (!pipeline) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Enquiries" description="Leads and cases, worked through pipelines." />
        <div className="text-muted-foreground rounded-md border p-6 text-sm">
          {bootstrap.can.settings ? (
            <>
              There are no pipelines yet.{" "}
              <Link className="underline" href="/settings/enquiries">
                Create one in Settings → Enquiries
              </Link>
              .
            </>
          ) : (
            "There are no pipelines yet. Ask an administrator to set them up in Settings."
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader title="Enquiries" description="Leads and cases, worked through pipelines.">
        {bootstrap.can.manage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportCsv("enquiries")}>
                Enquiries (current filters)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportCsv("activity")}>
                Activity log (current filters)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {bootstrap.can.settings && (
          <Button variant="outline" size="icon-sm" asChild aria-label="Enquiry settings">
            <Link href="/settings/enquiries">
              <Settings />
            </Link>
          </Button>
        )}
        {bootstrap.can.manage && (
          <Button size="sm" onClick={() => setNewOpen({ open: true })}>
            <Plus /> New enquiry
          </Button>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 gap-4">
        <nav
          aria-label="Pipelines"
          className="hidden w-48 shrink-0 flex-col gap-0.5 overflow-y-auto md:flex"
        >
          {pipelines.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={p.id === pipeline.id ? "page" : undefined}
              onClick={() => setParam({ pipeline: p.id })}
              className={cn(
                "hover:bg-accent rounded-md px-3 py-1.5 text-start text-sm",
                p.id === pipeline.id ? "bg-accent font-medium" : "text-muted-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="md:hidden">
              <select
                aria-label="Pipeline"
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                value={pipeline.id}
                onChange={(e) => setParam({ pipeline: e.target.value })}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="relative w-56">
              <Search
                className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2"
                aria-hidden
              />
              <Input
                aria-label="Search enquiries"
                className="h-8 ps-8"
                placeholder="Search name, phone, #"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div role="group" aria-label="Open or closed" className="flex rounded-md border p-0.5">
              {(["open", "closed"] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={filter.scope === s ? "secondary" : "ghost"}
                  className="h-7"
                  aria-pressed={filter.scope === s}
                  onClick={() => setFilter((f) => ({ ...f, scope: s, status: undefined }))}
                >
                  {s === "open" ? "Open" : "Closed"}
                </Button>
              ))}
            </div>
            <FilterPopover
              bootstrap={bootstrap}
              pipeline={pipeline}
              filter={filter}
              onChange={setFilter}
            />
            <ViewsMenu
              bootstrap={bootstrap}
              views={bootstrap.views}
              activeId={viewId}
              filter={filter}
              pipelineId={pipeline.id}
              columns={columnOrder}
              onApply={applyView}
              onChanged={() => router.refresh()}
            />
            <div role="group" aria-label="Layout" className="ms-auto flex rounded-md border p-0.5">
              <Button
                size="sm"
                variant={mode === "board" ? "secondary" : "ghost"}
                className="h-7"
                aria-pressed={mode === "board"}
                onClick={() => setParam({ mode: null })}
              >
                <KanbanSquare /> Board
              </Button>
              <Button
                size="sm"
                variant={mode === "table" ? "secondary" : "ghost"}
                className="h-7"
                aria-pressed={mode === "table"}
                onClick={() => setParam({ mode: "table" })}
              >
                <Table2 /> Table
              </Button>
            </div>
          </div>

          {mode === "table" && selectedIds.length > 0 && bootstrap.can.manage && (
            <BulkBar
              ids={selectedIds}
              bootstrap={bootstrap}
              pipeline={pipeline}
              onClear={() => setRowSelection({})}
              onDone={() => {
                setRowSelection({});
                reload();
              }}
            />
          )}

          {mode === "board" ? (
            <Kanban
              pipeline={pipeline}
              columns={columns}
              loading={boardLoading}
              canManage={bootstrap.can.manage}
              timezone={bootstrap.timezone}
              slaHours={bootstrap.slaHours}
              onOpen={(id) => setParam({ enquiry: id })}
              onMove={move}
              onAdd={(stageId) => setNewOpen({ open: true, stageId })}
              onLoadMore={(stageId) => void showMore(stageId)}
            />
          ) : (
            <DataGrid
              columns={columnDefs}
              data={rows}
              loading={tableLoading}
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
              onRowSelectionChange={setRowSelection}
              onRowClick={(r) => setParam({ enquiry: r.id })}
              emptyText={
                total === 0 && !filterCount && !filter.search
                  ? "No enquiries in this pipeline yet."
                  : "No enquiries match."
              }
            />
          )}
        </div>
      </div>

      {bootstrap.can.manage && (
        <NewEnquiryDialog
          key={`${newOpen.open}:${newOpen.stageId ?? ""}:${pipeline.id}`}
          bootstrap={bootstrap}
          open={newOpen.open}
          onOpenChange={(o) => setNewOpen((s) => ({ ...s, open: o }))}
          pipelineId={pipeline.id}
          stageId={newOpen.stageId}
          onCreated={(id) => {
            reload();
            setParam({ enquiry: id });
          }}
        />
      )}

      <EnquiryDrawer
        enquiryId={enquiryId}
        bootstrap={bootstrap}
        onClose={() => setParam({ enquiry: null })}
        onChanged={reload}
      />
    </div>
  );
}
