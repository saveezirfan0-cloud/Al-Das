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
  ChevronDown,
  Download,
  Filter as FilterIcon,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DataGrid } from "@/components/data-grid/data-grid";
import { FilterPanel } from "@/components/filter-builder/filter-panel";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { countConditions, filterSchema, type Filter } from "@/lib/filters/ast";
import type { PortalRow } from "@/lib/portal/types";
import type { SavedViewDto } from "@/lib/portal/server";

import { deletePortalView, listRecords, previewFilterCount, savePortalGridPrefs } from "./actions";
import { CreateDialog } from "./create-dialog";
import { buildPortalColumns } from "./portal-columns";
import { RecordDrawer } from "./record-drawer";
import { SaveViewDialog } from "./save-view-dialog";
import type { PortalBootstrap, PortalGridPrefs } from "./types";

type ViewColumns = PortalGridPrefs["columns"];

function parseViewColumns(v: unknown): ViewColumns {
  return Array.isArray(v)
    ? v.filter(
        (c): c is ViewColumns[number] => !!c && typeof (c as { id?: unknown }).id === "string",
      )
    : [];
}

export function PortalWorkspace({ bootstrap }: { bootstrap: PortalBootstrap }) {
  const def = bootstrap.object;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const recordId = params.get("record");
  const viewId = params.get("view");

  const [views, setViews] = React.useState<SavedViewDto[]>(bootstrap.views);
  React.useEffect(() => setViews(bootstrap.views), [bootstrap.views]);
  const [filter, setFilter] = React.useState<Filter | null>(null);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(bootstrap.gridPrefs?.pageSize ?? 100);
  const [rows, setRows] = React.useState<PortalRow[]>([]);
  const [links, setLinks] = React.useState<Record<string, Record<string, string>>>({});
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState<{ open: boolean; update: boolean }>({
    open: false,
    update: false,
  });
  const [reloadKey, setReloadKey] = React.useState(0);

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

  const columns = React.useMemo(
    () => buildPortalColumns(def, { timezone: bootstrap.timezone, links }),
    [def, bootstrap.timezone, links],
  );

  // First use: hide the columns the object marks as default-hidden.
  React.useEffect(() => {
    if (prefs) return;
    setColumnVisibility(
      Object.fromEntries(
        columns
          .filter((c) => (c.meta as { defaultHidden?: boolean } | undefined)?.defaultHidden)
          .map((c) => [c.id, false]),
      ),
    );
    // columns identity changes with link titles; the defaults only matter once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, def.key]);

  const currentColumns = React.useCallback((): ViewColumns => {
    const ordered = columnOrder.length ? columnOrder : columns.map((c) => c.id);
    return ordered.map((id) => ({
      id,
      width: columnSizing[id],
      hidden: columnVisibility[id] === false,
    }));
  }, [columnOrder, columns, columnSizing, columnVisibility]);

  // Persist the per-user layout (debounced)
  const layoutReady = React.useRef(false);
  React.useEffect(() => {
    if (!layoutReady.current) {
      layoutReady.current = true;
      return;
    }
    const handle = setTimeout(() => {
      void savePortalGridPrefs(def.key, { columns: currentColumns(), pageSize });
    }, 800);
    return () => clearTimeout(handle);
  }, [columnVisibility, columnSizing, columnOrder, pageSize, def.key, currentColumns]);

  React.useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
    setRowSelection({});
  }, [filter, debouncedSearch, sorting, pageSize]);

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

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listRecords(def.key, { filter, search: debouncedSearch || null, sort, page, pageSize }).then(
      (res) => {
        if (cancelled) return;
        setLoading(false);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setRows(res.data.rows);
        setTotal(res.data.total);
        setLinks(res.data.links);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [def.key, filter, debouncedSearch, sort, page, pageSize, reloadKey]);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  const setParam = React.useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const activeView = viewId ? (views.find((v) => v.id === viewId) ?? null) : null;

  // Apply a saved view: from the menu, or from a shared ?view= link on first load.
  const appliedView = React.useRef<string | null>(null);
  const applyView = React.useCallback((v: SavedViewDto) => {
    appliedView.current = v.id;
    const f = filterSchema.safeParse(v.filter);
    setFilter(
      f.success && countConditions(f.data.include) + countConditions(f.data.exclude ?? null) > 0
        ? f.data
        : null,
    );
    const sortSpec = Array.isArray(v.sort)
      ? (v.sort as Array<{ field: string; dir: "asc" | "desc" }>)
      : [];
    setSorting(sortSpec.map((s) => ({ id: s.field, desc: s.dir === "desc" })));
    const cols = parseViewColumns(v.columns);
    if (cols.length > 0) {
      setColumnOrder(cols.map((c) => c.id));
      setColumnVisibility(
        Object.fromEntries(cols.filter((c) => c.hidden).map((c) => [c.id, false])),
      );
      setColumnSizing(
        Object.fromEntries(cols.filter((c) => c.width).map((c) => [c.id, c.width as number])),
      );
    }
  }, []);

  React.useEffect(() => {
    if (!viewId) {
      appliedView.current = null;
      return;
    }
    if (appliedView.current === viewId) return;
    const v = views.find((x) => x.id === viewId);
    if (v) applyView(v);
  }, [viewId, views, applyView]);

  const activeConditions = filter
    ? countConditions(filter.include) + countConditions(filter.exclude ?? null)
    : 0;

  async function exportCsv(scope: "current" | "all") {
    const visible = currentColumns()
      .filter((c) => !c.hidden)
      .map((c) => c.id);
    const res = await fetch(`/api/portal/${def.key}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        scope === "all"
          ? { scope, columns: visible }
          : { scope, filter, search: debouncedSearch || null, sort, columns: visible },
      ),
    });
    if (!res.ok) {
      toast.error(
        res.status === 403 ? "You do not have permission to export this." : "Export failed.",
      );
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${def.key}-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function removeView(v: SavedViewDto) {
    if (!confirm(`Delete the view “${v.name}”?`)) return;
    const res = await deletePortalView(def.key, v.id);
    if (!res.ok) return toast.error(res.error);
    setViews((prev) => prev.filter((x) => x.id !== v.id));
    if (viewId === v.id) setParam({ view: null });
    toast.success("View deleted.");
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader title={def.label} description={def.description}>
        {bootstrap.can.export && (
          <>
            <Button variant="outline" size="sm" onClick={() => exportCsv("current")}>
              <Download /> Export view
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportCsv("all")}>
              <Download /> Export all
            </Button>
          </>
        )}
        {bootstrap.can.create && (
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus /> New
          </Button>
        )}
      </PageHeader>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-72 max-w-full">
            <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${def.label.toLowerCase()}`}
              className="h-9 pl-8"
              aria-label={`Search ${def.label}`}
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Bookmark /> {activeView ? activeView.name : "Views"} <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Saved views</DropdownMenuLabel>
              {views.length === 0 && (
                <div className="text-muted-foreground px-2 py-1.5 text-sm">No saved views yet.</div>
              )}
              {views.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onSelect={() => {
                    applyView(v); // also re-applies when the same view is picked again
                    setParam({ view: v.id });
                  }}
                  className="justify-between gap-2"
                >
                  <span className="truncate">{v.name}</span>
                  <span className="flex items-center gap-1">
                    {(v.sharedAll || v.sharedTeamIds.length > 0) && (
                      <Badge variant="outline">Shared</Badge>
                    )}
                    {v.ownerId === bootstrap.userId && (
                      <button
                        type="button"
                        aria-label={`Delete view ${v.name}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeView(v);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {activeView && (
                <DropdownMenuItem
                  disabled={activeView.ownerId !== bootstrap.userId}
                  onSelect={() => setSaveOpen({ open: true, update: true })}
                >
                  Update “{activeView.name}”
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setSaveOpen({ open: true, update: false })}>
                Save current as new view…
              </DropdownMenuItem>
              {activeView && (
                <DropdownMenuItem
                  onSelect={() => {
                    setFilter(null);
                    setSorting([]);
                    setParam({ view: null });
                  }}
                >
                  Leave view
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

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
          onRowSelectionChange={setRowSelection}
          onRowClick={(r) => setParam({ record: r.id })}
          emptyText={
            total === 0 && !activeConditions && !debouncedSearch
              ? `No ${def.label.toLowerCase()} yet. They appear here after the Airtable import.`
              : "No records match."
          }
        />
      </div>

      <FilterPanel
        open={filterOpen}
        onOpenChange={setFilterOpen}
        value={filter}
        onApply={setFilter}
        fields={bootstrap.fields}
        options={{}}
        previewCount={async (f) => {
          const res = await previewFilterCount(def.key, f);
          return res.ok ? { count: res.data.count } : { error: res.error };
        }}
      />

      {bootstrap.can.create && (
        <CreateDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          bootstrap={bootstrap}
          onCreated={(id) => {
            reload();
            setParam({ record: id });
          }}
        />
      )}

      <SaveViewDialog
        open={saveOpen.open}
        onOpenChange={(o) => setSaveOpen((s) => ({ ...s, open: o }))}
        objectKey={def.key}
        existing={saveOpen.update ? activeView : null}
        canShare={bootstrap.can.write}
        snapshot={{ filter, columns: currentColumns(), sort }}
        onSaved={(id) => {
          // The new view is already what is on screen; refresh pulls the saved list from the server.
          appliedView.current = id;
          router.refresh();
          setParam({ view: id });
        }}
      />

      <RecordDrawer
        recordId={recordId}
        bootstrap={bootstrap}
        onClose={() => setParam({ record: null })}
        onChanged={reload}
      />
    </div>
  );
}
