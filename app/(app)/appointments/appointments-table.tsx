"use client";

import * as React from "react";
import type {
  ColumnSizingState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import { Download, Search, X } from "lucide-react";
import { toast } from "sonner";

import { DataGrid, type DataGridColumn } from "@/components/data-grid/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APPOINTMENT_STATUSES, STATUS_LABELS } from "@/lib/appointments/status";
import { cn } from "@/lib/utils";

import { saveGridPrefs } from "../contacts/actions";
import { exportAppointments, listAppointments } from "./actions";
import { dateTimeLabel, REMINDER_LABELS, STATUS_STYLES, timeLabel } from "./format";
import type { AppointmentsBootstrap, ApptRow, ListQuery } from "./types";

const ALL = "__all__";

function buildColumns(b: AppointmentsBootstrap): DataGridColumn<ApptRow>[] {
  const name = (list: Array<{ id: string; name: string }>, id: string | null) =>
    list.find((x) => x.id === id)?.name ?? "";
  const col = (
    id: string,
    label: string,
    cell: (r: ApptRow) => React.ReactNode,
    extra: Partial<DataGridColumn<ApptRow>> & { defaultHidden?: boolean } = {},
  ): DataGridColumn<ApptRow> => {
    const { defaultHidden, ...rest } = extra;
    return {
      id,
      label,
      header: label,
      accessorFn: (r) => r.id,
      cell: ({ row }) => cell(row.original),
      meta: { defaultHidden: !!defaultHidden },
      ...rest,
    };
  };
  return [
    col("number", "#", (r) => <span className="tabular-nums">{r.number}</span>, {
      sortKey: "number",
      size: 70,
    }),
    col("patient", "Patient", (r) => <span className="font-medium">{r.contact_name}</span>, {
      size: 200,
      locked: true,
    }),
    col("phone", "Phone", (r) => <span className="tabular-nums">{r.phone ?? ""}</span>, {
      size: 150,
    }),
    col("channel", "Channel", (r) => r.channel_name ?? "", { size: 110, defaultHidden: true }),
    col(
      "status",
      "Status",
      (r) => (
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 text-xs",
            STATUS_STYLES[r.status].replace("line-through", ""),
          )}
        >
          {STATUS_LABELS[r.status]}
        </span>
      ),
      { sortKey: "status", size: 110 },
    ),
    col("starts", "Starts", (r) => dateTimeLabel(r.starts_at, b.timezone), {
      sortKey: "starts_at",
      size: 190,
    }),
    col("ends", "Ends", (r) => timeLabel(r.ends_at, b.timezone), { size: 80, defaultHidden: true }),
    col("location", "Location", (r) => name(b.locations, r.location_id), { size: 140 }),
    col("specialist", "Specialist", (r) => name(b.specialists, r.specialist_id), { size: 160 }),
    col("service", "Service", (r) => name(b.services, r.service_id), { size: 150 }),
    col(
      "reminder",
      "Reminder",
      (r) =>
        r.reminder ? (
          <Badge variant={r.reminder === "failed" ? "destructive" : "outline"}>
            {REMINDER_LABELS[r.reminder]}
          </Badge>
        ) : (
          ""
        ),
      { size: 110 },
    ),
    col("source", "Source", (r) => r.source, { size: 90, defaultHidden: true }),
    col("external_id", "External ID", (r) => r.external_id ?? "", {
      size: 120,
      defaultHidden: true,
    }),
    col("notes", "Notes", (r) => <span className="text-muted-foreground">{r.notes ?? ""}</span>, {
      size: 220,
      defaultHidden: true,
    }),
    col("created", "Created", (r) => dateTimeLabel(r.created_at, b.timezone), {
      sortKey: "created_at",
      size: 190,
      defaultHidden: true,
    }),
  ];
}

export function AppointmentsTable({
  bootstrap,
  reloadKey,
  onRowClick,
}: {
  bootstrap: AppointmentsBootstrap;
  reloadKey: number;
  onRowClick: (id: string) => void;
}) {
  const prefs = bootstrap.gridPrefs;
  const columns = React.useMemo(() => buildColumns(bootstrap), [bootstrap]);

  const [filters, setFilters] = React.useState<{
    q: string;
    from: string;
    to: string;
    locationId: string;
    specialistId: string;
    serviceId: string;
    source: string;
    status: string[];
  }>({
    q: "",
    from: "",
    to: "",
    locationId: ALL,
    specialistId: ALL,
    serviceId: ALL,
    source: ALL,
    status: [],
  });
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "starts", desc: true }]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(prefs?.pageSize ?? 100);
  const [rows, setRows] = React.useState<ApptRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [selection, setSelection] = React.useState<RowSelectionState>({});
  const [exporting, setExporting] = React.useState(false);

  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() =>
    prefs
      ? Object.fromEntries(prefs.columns.filter((c) => c.hidden).map((c) => [c.id, false]))
      : Object.fromEntries(
          columns
            .filter((c) => (c.meta as { defaultHidden?: boolean } | undefined)?.defaultHidden)
            .map((c) => [c.id, false]),
        ),
  );
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>(() =>
    Object.fromEntries(
      (prefs?.columns ?? []).filter((c) => c.width).map((c) => [c.id, c.width as number]),
    ),
  );
  const [columnOrder, setColumnOrder] = React.useState<string[]>(() =>
    (prefs?.columns ?? []).map((c) => c.id),
  );

  // Persist the layout per user (debounced), like the contacts grid.
  const layoutReady = React.useRef(false);
  React.useEffect(() => {
    if (!layoutReady.current) {
      layoutReady.current = true;
      return;
    }
    const handle = setTimeout(() => {
      const ordered = columnOrder.length ? columnOrder : columns.map((c) => c.id);
      void saveGridPrefs("appointments", {
        columns: ordered.map((id) => ({
          id,
          width: columnSizing[id],
          hidden: columnVisibility[id] === false,
        })),
        pageSize,
      });
    }, 800);
    return () => clearTimeout(handle);
  }, [columnVisibility, columnSizing, columnOrder, pageSize, columns]);

  React.useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(filters.q.trim()), 300);
    return () => clearTimeout(h);
  }, [filters.q]);

  const query = React.useMemo<ListQuery>(() => {
    const s = sorting[0];
    const field =
      s?.id === "starts"
        ? "starts_at"
        : s?.id === "number"
          ? "number"
          : s?.id === "status"
            ? "status"
            : s?.id === "created"
              ? "created_at"
              : "starts_at";
    return {
      q: debouncedQ || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      locationId: filters.locationId === ALL ? undefined : filters.locationId,
      specialistId: filters.specialistId === ALL ? undefined : filters.specialistId,
      serviceId: filters.serviceId === ALL ? undefined : filters.serviceId,
      source: filters.source === ALL ? undefined : (filters.source as "portal" | "unite" | "bot"),
      status: filters.status.length ? filters.status : undefined,
      sort: { field, dir: s?.desc === false ? "asc" : "desc" },
    };
  }, [filters, debouncedQ, sorting]);

  // Back to page 1 when filters change.
  React.useEffect(() => setPage(1), [query]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listAppointments({ ...query, page, pageSize }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok && res.data) {
        setRows(res.data.rows);
        setTotal(res.data.total);
      } else if (!res.ok) toast.error(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [query, page, pageSize, reloadKey]);

  async function exportCsv(scope: "filtered" | "all") {
    setExporting(true);
    const res = await exportAppointments(query, scope);
    setExporting(false);
    if (!res.ok || !res.data) return toast.error(res.ok ? "Export failed." : res.error);
    const url = URL.createObjectURL(new Blob([res.data.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `appointments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${res.data.rows} appointment${res.data.rows === 1 ? "" : "s"}.`);
  }

  const set = <K extends keyof typeof filters>(k: K, v: (typeof filters)[K]) =>
    setFilters((p) => ({ ...p, [k]: v }));
  const dirty =
    filters.q ||
    filters.from ||
    filters.to ||
    filters.locationId !== ALL ||
    filters.specialistId !== ALL ||
    filters.serviceId !== ALL ||
    filters.source !== ALL ||
    filters.status.length > 0;

  const pick = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    items: Array<{ id: string; name: string }>,
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}s</SelectItem>
        {items.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
          <Input
            className="w-60 pl-8"
            placeholder="Search patient, phone, #, Unite ID"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>
        <Input
          type="date"
          className="w-40"
          aria-label="From date"
          value={filters.from}
          onChange={(e) => set("from", e.target.value)}
        />
        <Input
          type="date"
          className="w-40"
          aria-label="To date"
          value={filters.to}
          onChange={(e) => set("to", e.target.value)}
        />
        {pick(filters.locationId, (v) => set("locationId", v), "Location", bootstrap.locations)}
        {pick(
          filters.specialistId,
          (v) => set("specialistId", v),
          "Specialist",
          bootstrap.specialists,
        )}
        {pick(filters.serviceId, (v) => set("serviceId", v), "Service", bootstrap.services)}
        <MultiSelect
          className="w-40"
          options={APPOINTMENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          value={filters.status}
          onChange={(v) => set("status", v)}
          placeholder="Any status"
        />
        <Select value={filters.source} onValueChange={(v) => set("source", v)}>
          <SelectTrigger className="w-32" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any source</SelectItem>
            <SelectItem value="portal">Portal</SelectItem>
            <SelectItem value="unite">Unite</SelectItem>
            <SelectItem value="bot">Bot</SelectItem>
          </SelectContent>
        </Select>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setFilters({
                q: "",
                from: "",
                to: "",
                locationId: ALL,
                specialistId: ALL,
                serviceId: ALL,
                source: ALL,
                status: [],
              })
            }
          >
            <X /> Clear
          </Button>
        )}
        {bootstrap.can.export && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto" disabled={exporting}>
                <Download /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportCsv("filtered")}>
                Current filters ({total})
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportCsv("all")}>
                All appointments
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <DataGrid
        className="min-h-[420px]"
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
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        onRowClick={(r) => onRowClick(r.id)}
        emptyText={dirty ? "No appointments match." : "No appointments yet."}
      />
    </div>
  );
}
