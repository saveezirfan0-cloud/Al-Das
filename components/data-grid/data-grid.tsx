"use client";

import * as React from "react";
import {
  type ColumnDef,
  type ColumnSizingState,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type DataGridColumn<T> = ColumnDef<T, unknown> & {
  /** Stable id used in saved layouts. */
  id: string;
  /** Shown in the column chooser. */
  label: string;
  /** Server-side sort key; omit for unsortable columns. */
  sortKey?: string;
  /** Cannot be hidden. */
  locked?: boolean;
};

export type DataGridProps<T extends { id: string }> = {
  columns: DataGridColumn<T>[];
  data: T[];
  loading?: boolean;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
  columnSizing: ColumnSizingState;
  onColumnSizingChange: OnChangeFn<ColumnSizingState>;
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  onRowClick?: (row: T) => void;
  emptyText?: string;
  /** Extra controls rendered next to the pagination. */
  footerStart?: React.ReactNode;
  className?: string;
};

const PAGE_SIZES = [50, 100, 200, 500];

/**
 * Virtualised, server-paginated grid on TanStack Table: resizable columns with
 * persisted widths, a column chooser, server-side sorting and row selection.
 */
export function DataGrid<T extends { id: string }>(props: DataGridProps<T>) {
  const {
    columns,
    data,
    loading,
    total,
    page,
    pageSize,
    onPageChange,
    onPageSizeChange,
    sorting,
    onSortingChange,
    columnVisibility,
    onColumnVisibilityChange,
    columnSizing,
    onColumnSizingChange,
    columnOrder,
    onColumnOrderChange,
    rowSelection,
    onRowSelectionChange,
    onRowClick,
    emptyText = "No rows",
    footerStart,
    className,
  } = props;

  const selectColumn = React.useMemo<ColumnDef<T, unknown>>(
    () => ({
      id: "__select",
      size: 36,
      minSize: 36,
      maxSize: 36,
      enableResizing: false,
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all on this page"
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
                ? "indeterminate"
                : false
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
        />
      ),
      cell: ({ row }) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            aria-label="Select row"
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
          />
        </div>
      ),
    }),
    [],
  );

  const table = useReactTable({
    data,
    columns: [selectColumn, ...columns],
    state: {
      sorting,
      columnVisibility,
      columnSizing,
      rowSelection,
      columnOrder: ["__select", ...columnOrder],
    },
    getRowId: (row) => row.id,
    manualSorting: true,
    manualPagination: true,
    enableMultiSort: false,
    columnResizeMode: "onChange",
    onSortingChange,
    onColumnVisibilityChange,
    onColumnSizingChange,
    onRowSelectionChange,
    getCoreRowModel: getCoreRowModel(),
    defaultColumn: { minSize: 60, size: 160, maxSize: 900 },
  });

  const parentRef = React.useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const tableWidth = table.getTotalSize();

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col rounded-xl border", className)}>
      <div ref={parentRef} className="relative min-h-0 flex-1 overflow-auto">
        <table className="text-sm" style={{ width: tableWidth, minWidth: "100%" }}>
          <thead className="bg-background sticky top-0 z-10 border-b">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const col = header.column.columnDef as DataGridColumn<T>;
                  const sortable = !!col.sortKey;
                  const sorted = sorting.find((s) => s.id === header.column.id);
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() }}
                      className="text-muted-foreground group relative h-9 px-2 text-left text-xs font-medium whitespace-nowrap select-none"
                    >
                      {header.isPlaceholder ? null : !sortable ? (
                        // Not sortable: a plain cell, so a checkbox header (select all) is never nested in a button.
                        <div className="flex w-full items-center gap-1 truncate">
                          <span className="truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            onSortingChange(
                              sorted
                                ? sorted.desc
                                  ? []
                                  : [{ id: header.column.id, desc: true }]
                                : [{ id: header.column.id, desc: false }],
                            );
                          }}
                          className="hover:text-foreground flex w-full cursor-pointer items-center gap-1 truncate"
                        >
                          <span className="truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {sorted &&
                            (sorted.desc ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ArrowUp className="size-3" />
                            ))}
                        </button>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className={cn(
                            "absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none",
                            "hover:bg-primary/40 group-hover:bg-border",
                            header.column.getIsResizing() && "bg-primary",
                          )}
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((vr) => {
              const row = rows[vr.index];
              return (
                <tr
                  key={row.id}
                  data-index={vr.index}
                  ref={virtualizer.measureElement}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    "hover:bg-muted/50 border-b",
                    onRowClick && "cursor-pointer",
                    row.getIsSelected() && "bg-primary/5",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      style={{ width: cell.column.getSize() }}
                      className="h-10 truncate px-2 align-middle whitespace-nowrap"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: paddingBottom }} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && !loading && (
          <div className="text-muted-foreground absolute inset-0 top-9 flex items-center justify-center text-sm">
            {emptyText}
          </div>
        )}
        {loading && (
          <div className="bg-background/60 absolute inset-0 top-9 flex items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          {footerStart}
          <ColumnChooser
            columns={columns}
            visibility={columnVisibility}
            onVisibilityChange={onColumnVisibilityChange}
            order={columnOrder}
            onOrderChange={onColumnOrderChange}
            onReset={() => onColumnSizingChange({})}
          />
          <span className="text-muted-foreground">
            {from}–{to} of {total.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-24 text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="First page"
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="px-1 tabular-nums">
            {page} / {pageCount}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Last page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(pageCount)}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ColumnChooser<T>({
  columns,
  visibility,
  onVisibilityChange,
  order,
  onOrderChange,
  onReset,
}: {
  columns: DataGridColumn<T>[];
  visibility: VisibilityState;
  onVisibilityChange: OnChangeFn<VisibilityState>;
  order: string[];
  onOrderChange: (order: string[]) => void;
  onReset: () => void;
}) {
  const ordered = [...columns].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  function move(id: string, dir: -1 | 1) {
    const ids = ordered.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onOrderChange(ids);
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
          <Columns3 className="size-3.5" /> Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <ScrollArea className="max-h-72">
          <ul className="flex flex-col gap-0.5">
            {ordered.map((c) => {
              const visible = visibility[c.id] !== false;
              return (
                <li key={c.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm">
                  <Checkbox
                    id={`col-${c.id}`}
                    checked={visible}
                    disabled={c.locked}
                    onCheckedChange={(v) =>
                      onVisibilityChange((prev) => ({ ...prev, [c.id]: !!v }))
                    }
                  />
                  <label htmlFor={`col-${c.id}`} className="flex-1 truncate">
                    {c.label}
                  </label>
                  <button
                    type="button"
                    aria-label="Move up"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => move(c.id, -1)}
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => move(c.id, 1)}
                  >
                    <ArrowDown className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
        <div className="mt-2 flex justify-between border-t pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onVisibilityChange({})}
          >
            Show all
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onReset}>
            Reset widths
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
