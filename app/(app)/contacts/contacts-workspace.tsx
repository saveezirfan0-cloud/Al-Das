"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColumnSizingState, RowSelectionState, SortingState, VisibilityState } from "@tanstack/react-table";
import { Download, Filter as FilterIcon, Plus, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { DataGrid } from "@/components/data-grid/data-grid";
import { FilterPanel } from "@/components/filter-builder/filter-panel";
import type { OptionSources } from "@/components/filter-builder/filter-builder";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ContactListRow } from "@/lib/contacts/query";
import { countConditions, type Filter } from "@/lib/filters/ast";

import { listContacts, listMatchingIds, previewFilterCount, saveGridPrefs, type GridPrefs } from "./actions";
import { BulkBar } from "./bulk-bar";
import { ContactDrawer } from "./contact-drawer";
import { buildContactColumns } from "./contacts-grid";
import { DuplicatesPanel } from "./duplicates-panel";
import { ImportDialog } from "./import-dialog";
import { NewContactDialog } from "./new-contact-dialog";
import { SegmentDialog } from "./segment-dialog";
import type { ContactsBootstrap, TagOption } from "./types";
import { ViewsRail } from "./views-rail";

export function ContactsWorkspace({ bootstrap }: { bootstrap: ContactsBootstrap }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const view = params.get("view") ?? "all";
  const segmentId = params.get("segment");
  const contactId = params.get("contact");
  const showDupes = params.get("dupes") === "1";

  const [tags, setTags] = React.useState<TagOption[]>(bootstrap.tags);
  const [segments, setSegments] = React.useState(bootstrap.segments);
  const [filter, setFilter] = React.useState<Filter | null>(null);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(bootstrap.gridPrefs?.pageSize ?? 100);
  const [rows, setRows] = React.useState<ContactListRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [allMatchingIds, setAllMatchingIds] = React.useState<string[] | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [segmentDraft, setSegmentDraft] = React.useState<{ open: boolean; id?: string; filter?: Filter | null }>({ open: false });
  const [reloadKey, setReloadKey] = React.useState(0);

  // Column layout (persisted per user)
  const prefs = bootstrap.gridPrefs;
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() =>
    Object.fromEntries((prefs?.columns ?? []).filter((c) => c.hidden).map((c) => [c.id, false])),
  );
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>(() =>
    Object.fromEntries((prefs?.columns ?? []).filter((c) => c.width).map((c) => [c.id, c.width as number])),
  );
  const [columnOrder, setColumnOrder] = React.useState<string[]>(() => (prefs?.columns ?? []).map((c) => c.id));

  const columns = React.useMemo(
    () => buildContactColumns({ customFields: bootstrap.customFields, timezone: bootstrap.timezone, users: bootstrap.users }),
    [bootstrap.customFields, bootstrap.timezone, bootstrap.users],
  );

  // Hide columns that are not in the default set on first use.
  React.useEffect(() => {
    if (prefs) return;
    setColumnVisibility(Object.fromEntries(columns.filter((c) => c.meta && (c.meta as { defaultHidden?: boolean }).defaultHidden).map((c) => [c.id, false])));
  }, [columns, prefs]);

  // Persist layout (debounced)
  const layoutReady = React.useRef(false);
  React.useEffect(() => {
    if (!layoutReady.current) {
      layoutReady.current = true;
      return;
    }
    const handle = setTimeout(() => {
      const ordered = columnOrder.length ? columnOrder : columns.map((c) => c.id);
      const next: GridPrefs = {
        columns: ordered.map((id) => ({ id, width: columnSizing[id], hidden: columnVisibility[id] === false })),
        pageSize,
      };
      void saveGridPrefs("contacts", next);
    }, 800);
    return () => clearTimeout(handle);
  }, [columnVisibility, columnSizing, columnOrder, pageSize, columns]);

  React.useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Reset paging and selection whenever the list definition changes
  React.useEffect(() => {
    setPage(1);
    setRowSelection({});
    setAllMatchingIds(null);
  }, [view, segmentId, filter, debouncedSearch, sorting, pageSize]);

  const sort = React.useMemo(
    () =>
      sorting
        .map((s) => {
          const col = columns.find((c) => c.id === s.id);
          return col?.sortKey ? { field: col.sortKey, dir: s.desc ? ("desc" as const) : ("asc" as const) } : null;
        })
        .filter((s): s is { field: string; dir: "asc" | "desc" } => !!s),
    [sorting, columns],
  );

  const listInput = React.useMemo(
    () => ({ view, segmentId, filter, search: debouncedSearch || null, sort, page, pageSize }),
    [view, segmentId, filter, debouncedSearch, sort, page, pageSize],
  );

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listContacts(listInput).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setRows(res.data.rows);
      setTotal(res.data.total);
    });
    return () => {
      cancelled = true;
    };
  }, [listInput, reloadKey]);

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

  const selectedIds = allMatchingIds ?? Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const activeConditions = filter ? countConditions(filter.include) + countConditions(filter.exclude ?? null) : 0;

  const optionSources: OptionSources = React.useMemo(
    () => ({
      users: bootstrap.users.map((u) => ({ value: u.id, label: u.label })),
      tags: tags.map((t) => ({ value: t.id, label: t.name })),
      segments: segments.map((s) => ({ value: s.id, label: s.name })),
    }),
    [bootstrap.users, tags, segments],
  );

  async function selectAllMatching() {
    const res = await listMatchingIds({ ...listInput, page: 1, pageSize: 10 });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setAllMatchingIds(res.data.ids);
    setRowSelection(Object.fromEntries(rows.map((r) => [r.id, true])));
  }

  async function exportCsv(scope: "current" | "all") {
    const res = await fetch("/api/contacts/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scope === "all" ? { scope } : { scope, view, segmentId, filter, search: debouncedSearch || null, sort }),
    });
    if (!res.ok) {
      toast.error(res.status === 403 ? "You do not have permission to export contacts." : "Export failed.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contacts-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const segmentName = segmentId ? segments.find((s) => s.id === segmentId)?.name : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader title="Contacts" description="One patient record across WhatsApp, Unite, enquiries and appointments.">
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
        {bootstrap.can.manage && (
          <>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload /> Import CSV
            </Button>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus /> New contact
            </Button>
          </>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 gap-4">
        <ViewsRail
          view={view}
          segmentId={segmentId}
          showDupes={showDupes}
          segments={segments}
          canManage={bootstrap.can.manage}
          onSelectView={(v) => setParam({ view: v === "all" ? null : v, segment: null, dupes: null })}
          onSelectSegment={(id) => setParam({ segment: id, view: null, dupes: null })}
          onShowDupes={() => setParam({ dupes: "1" })}
          onNewSegment={() => setSegmentDraft({ open: true })}
          onEditSegment={(id) => setSegmentDraft({ open: true, id })}
          onSegmentsChanged={(next) => setSegments(next)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {showDupes ? (
            <DuplicatesPanel timezone={bootstrap.timezone} canManage={bootstrap.can.manage} onOpenContact={(id) => setParam({ contact: id })} onMerged={reload} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-72 max-w-full">
                  <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email, ID" className="h-9 pl-8" aria-label="Search contacts" />
                  {search && (
                    <button type="button" aria-label="Clear search" className="text-muted-foreground absolute top-1/2 right-2 -translate-y-1/2" onClick={() => setSearch("")}>
                      <X className="size-4" />
                    </button>
                  )}
                </div>
                <Button variant={activeConditions ? "secondary" : "outline"} size="sm" onClick={() => setFilterOpen(true)}>
                  <FilterIcon /> Filters
                  {activeConditions > 0 && <Badge variant="default">{activeConditions}</Badge>}
                </Button>
                {activeConditions > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setFilter(null)}>
                    <X /> Clear
                  </Button>
                )}
                {segmentName && (
                  <Badge variant="outline" className="gap-1">
                    Segment: {segmentName}
                    <button type="button" aria-label="Leave segment" onClick={() => setParam({ segment: null })}>
                      <X className="size-3" />
                    </button>
                  </Badge>
                )}
              </div>

              {selectedIds.length > 0 && bootstrap.can.manage && (
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
                  tags={tags}
                  segments={segments.filter((s) => s.kind === "static")}
                  users={bootstrap.users}
                  customFields={bootstrap.customFields}
                  onTagCreated={(t) => setTags((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name)))}
                  onDone={() => {
                    setRowSelection({});
                    setAllMatchingIds(null);
                    reload();
                  }}
                />
              )}

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
                onRowClick={(r) => setParam({ contact: r.id })}
                emptyText={total === 0 && !activeConditions && !debouncedSearch ? "No contacts yet. Import a CSV or add one." : "No contacts match."}
              />
            </>
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
          const res = await previewFilterCount(f);
          return res.ok ? { count: res.data.count } : { error: res.error };
        }}
        onSaveAsSegment={bootstrap.can.manage ? (f) => setSegmentDraft({ open: true, filter: f }) : undefined}
      />

      <SegmentDialog
        open={segmentDraft.open}
        onOpenChange={(o) => setSegmentDraft((d) => ({ ...d, open: o }))}
        segment={segmentDraft.id ? segments.find((s) => s.id === segmentDraft.id) : undefined}
        initialFilter={segmentDraft.filter ?? null}
        fields={bootstrap.fields}
        options={optionSources}
        onSaved={(seg) => {
          setSegments((prev) => {
            const others = prev.filter((s) => s.id !== seg.id);
            return [...others, seg].sort((a, b) => a.name.localeCompare(b.name));
          });
          setParam({ segment: seg.id, view: null, dupes: null });
        }}
      />

      {bootstrap.can.manage && (
        <>
          <ImportDialog open={importOpen} onOpenChange={setImportOpen} customFields={bootstrap.customFields} onDone={reload} />
          <NewContactDialog
            open={newOpen}
            onOpenChange={setNewOpen}
            bootstrap={bootstrap}
            onCreated={(id) => {
              reload();
              setParam({ contact: id });
            }}
          />
        </>
      )}

      <ContactDrawer
        contactId={contactId}
        onClose={() => setParam({ contact: null })}
        bootstrap={bootstrap}
        tags={tags}
        onTagCreated={(t) => setTags((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name)))}
        onChanged={reload}
        onOpenContact={(id) => setParam({ contact: id })}
      />
    </div>
  );
}
