"use client";

import * as React from "react";
import type {
  ColumnSizingState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";

import type { DataGridProps } from "./data-grid";

/** A sort value for one column: strings sort case-insensitively, nulls last. */
export type SortAccessor<T> = (row: T) => string | number | null | undefined;

/**
 * The DataGrid's controlled state for a list that is already in the browser (a directory of a few hundred rows):
 * sorting and paging happen here instead of on the server. Spread the result into <DataGrid columns={…} />.
 */
export function useLocalGrid<T extends { id: string }>(
  rows: readonly T[],
  sortBy: Record<string, SortAccessor<T>>,
  initialSort: SortingState = [],
): Omit<DataGridProps<T>, "columns"> {
  const [sorting, setSorting] = React.useState<SortingState>(initialSort);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({});
  const [columnOrder, setColumnOrder] = React.useState<string[]>([]);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  const sorted = React.useMemo(() => {
    const s = sorting[0];
    const get = s ? sortBy[s.id] : undefined;
    if (!s || !get) return [...rows];
    const dir = s.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === y) return 0;
      if (x === null || x === undefined || x === "") return 1;
      if (y === null || y === undefined || y === "") return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { sensitivity: "base" }) * dir;
    });
  }, [rows, sorting, sortBy]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount);
  const data = React.useMemo(
    () => sorted.slice((current - 1) * pageSize, current * pageSize),
    [sorted, current, pageSize],
  );

  return {
    data,
    total: sorted.length,
    page: current,
    pageSize,
    onPageChange: setPage,
    onPageSizeChange: (n) => {
      setPageSize(n);
      setPage(1);
    },
    sorting,
    onSortingChange: (updater) => {
      setSorting(updater);
      setPage(1);
    },
    columnVisibility,
    onColumnVisibilityChange: setColumnVisibility,
    columnSizing,
    onColumnSizingChange: setColumnSizing,
    columnOrder,
    onColumnOrderChange: setColumnOrder,
    rowSelection,
    onRowSelectionChange: setRowSelection,
  };
}
