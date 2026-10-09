"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  RowSelectionState,
  SortingState,
  VisibilityState,
  ColumnSizingState,
} from "@tanstack/react-table";
import { CheckCheck, Loader2, Plus, RotateCcw, Search, Trash2, UserCog, X } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { DataGrid, type DataGridColumn } from "@/components/data-grid/data-grid";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/contacts/format";
import { createClient } from "@/lib/supabase/client";
import { TASK_TYPES, TASK_TYPE_LABELS } from "@/lib/tasks/constants";
import { dueState } from "@/lib/tasks/due";
import { TASK_STATES, type TaskState } from "@/lib/tasks/range";
import { cn } from "@/lib/utils";

import {
  assignTasksAction,
  deleteTasksAction,
  listTasks,
  setTasksDoneAction,
  type TaskRow,
} from "./actions";
import { TaskDrawer, type TaskDraft } from "./task-drawer";
import type { TasksBootstrap } from "./types";

const STATE_LABELS: Record<TaskState, string> = {
  open: "Open",
  overdue: "Overdue",
  today: "Due today",
  done: "Done",
  all: "All",
};

export function TasksWorkspace({ bootstrap }: { bootstrap: TasksBootstrap }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const stateParam = params.get("state");
  const state: TaskState = TASK_STATES.includes(stateParam as TaskState)
    ? (stateParam as TaskState)
    : "open";
  const assignee = params.get("assignee") === "all" ? "all" : "me";
  const type = TASK_TYPES.includes(params.get("type") as never)
    ? (params.get("type") as (typeof TASK_TYPES)[number])
    : null;

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "due_at", desc: false }]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [rows, setRows] = React.useState<TaskRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [reloadKey, setReloadKey] = React.useState(0);
  const [draft, setDraft] = React.useState<TaskDraft>({ open: false, task: null });
  const [pending, startTransition] = React.useTransition();
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({});
  const [columnOrder, setColumnOrder] = React.useState<string[]>([]);

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

  React.useEffect(() => {
    const handle = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
    setRowSelection({});
  }, [state, assignee, type, debounced, sorting, pageSize]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const sort = sorting[0];
    listTasks({
      assignee,
      state,
      type,
      search: debounced || null,
      sort: (sort?.id === "created_at" || sort?.id === "subject" ? sort.id : "due_at") as
        "due_at" | "created_at" | "subject",
      dir: sort?.desc ? "desc" : "asc",
      page,
      pageSize,
    }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) return void toast.error(res.error);
      setRows(res.data.rows);
      setTotal(res.data.total);
    });
    return () => {
      cancelled = true;
    };
  }, [assignee, state, type, debounced, sorting, page, pageSize, reloadKey]);

  // Realtime: someone else's task changes refresh the list.
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`tasks:${bootstrap.orgId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `org_id=eq.${bootstrap.orgId}` },
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

  const userName = React.useMemo(
    () => new Map(bootstrap.users.map((u) => [u.id, u.label])),
    [bootstrap.users],
  );

  function toggleDone(t: TaskRow) {
    startTransition(async () => {
      const res = await setTasksDoneAction([t.id], !t.done);
      if (!res.ok) toast.error(res.error);
      reload();
    });
  }

  const columns = React.useMemo<DataGridColumn<TaskRow>[]>(() => {
    const col = (
      id: string,
      label: string,
      cell: (t: TaskRow) => React.ReactNode,
      extra: Partial<DataGridColumn<TaskRow>> = {},
    ): DataGridColumn<TaskRow> => ({
      id,
      label,
      header: label,
      accessorFn: (t) => t.id,
      cell: ({ row }) => cell(row.original),
      ...extra,
    });
    return [
      col(
        "done",
        "Done",
        (t) => (
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={t.done}
              disabled={!bootstrap.can.manage}
              aria-label={t.done ? `Reopen ${t.subject}` : `Complete ${t.subject}`}
              onCheckedChange={() => toggleDone(t)}
            />
          </span>
        ),
        { size: 60, locked: true },
      ),
      col(
        "subject",
        "Task",
        (t) => (
          <span
            className={cn(
              "flex items-center gap-2",
              t.done && "text-muted-foreground line-through",
            )}
          >
            <Badge variant="outline">
              {TASK_TYPE_LABELS[t.type as (typeof TASK_TYPES)[number]] ?? t.type}
            </Badge>
            <span className="truncate font-medium">{t.subject}</span>
          </span>
        ),
        { sortKey: "subject", size: 320, locked: true },
      ),
      col(
        "due_at",
        "Due",
        (t) => {
          const s = dueState(t, new Date());
          return (
            <span className={cn("tabular-nums", s === "overdue" && "text-destructive font-medium")}>
              {formatDateTime(t.due_at, bootstrap.timezone)}
              {s === "overdue" && " · overdue"}
            </span>
          );
        },
        { sortKey: "due_at", size: 200 },
      ),
      col(
        "assignee",
        "Assigned to",
        (t) =>
          t.assignee_id ? (
            (userName.get(t.assignee_id) ?? "Unknown")
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          ),
        { size: 170 },
      ),
      col("contact", "Contact", (t) => t.contact?.full_name ?? "", { size: 170 }),
      col(
        "enquiry",
        "Enquiry",
        (t) =>
          t.enquiry && !t.enquiry.deleted_at ? (
            <Link
              href={`/enquiries?pipeline=all&scope=all&mode=table&enquiry=${t.enquiry.id}`}
              className="hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              #{t.enquiry.number} {t.enquiry.title}
            </Link>
          ) : (
            ""
          ),
        { size: 220 },
      ),
      col("created_at", "Created", (t) => formatDateTime(t.created_at, bootstrap.timezone), {
        sortKey: "created_at",
        size: 170,
      }),
    ];
    // toggleDone / reload are stable for the lifetime of the workspace
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap, userName]);

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);

  function bulk(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message ?? "Done.");
        setRowSelection({});
        reload();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="Tasks"
        description="Calls, follow-ups and reminders, with a nudge when they fall due."
      >
        {bootstrap.can.manage && (
          <Button size="sm" onClick={() => setDraft({ open: true, task: null })}>
            <Plus /> New task
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Whose tasks"
          className="bg-muted inline-flex rounded-lg p-0.5"
        >
          {(["me", "all"] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={assignee === a}
              onClick={() => setParam({ assignee: a === "me" ? null : "all" })}
              className={cn(
                "rounded-md px-3 py-1 text-sm",
                assignee === a ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
              )}
            >
              {a === "me" ? "Assigned to me" : "Everyone"}
            </button>
          ))}
        </div>
        <div className="w-36">
          <OptionSelect
            allowNone={false}
            value={state}
            options={TASK_STATES.map((s) => ({ value: s, label: STATE_LABELS[s] }))}
            onChange={(v) => setParam({ state: v && v !== "open" ? v : null })}
          />
        </div>
        <div className="w-36">
          <OptionSelect
            noneLabel="All types"
            value={type}
            options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))}
            onChange={(v) => setParam({ type: v })}
          />
        </div>
        <div className="relative w-64 max-w-full">
          <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject"
            className="h-9 pl-8"
            aria-label="Search tasks"
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
      </div>

      {selectedIds.length > 0 && bootstrap.can.manage && (
        <div className="bg-primary/5 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <span className="font-medium">{selectedIds.length} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
            Clear
          </Button>
          <span className="bg-border mx-1 h-5 w-px" />
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => bulk(() => setTasksDoneAction(selectedIds, true))}
          >
            <CheckCheck /> Mark done
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => bulk(() => setTasksDoneAction(selectedIds, false))}
          >
            <RotateCcw /> Reopen
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                <UserCog /> Assign
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 overflow-y-auto">
              <DropdownMenuItem onClick={() => bulk(() => assignTasksAction(selectedIds, null))}>
                Unassign
              </DropdownMenuItem>
              {bootstrap.users.map((u) => (
                <DropdownMenuItem
                  key={u.id}
                  onClick={() => bulk(() => assignTasksAction(selectedIds, u.id))}
                >
                  {u.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={pending}
            onClick={() =>
              confirm(`Delete ${selectedIds.length} task${selectedIds.length === 1 ? "" : "s"}?`) &&
              bulk(() => deleteTasksAction(selectedIds))
            }
          >
            <Trash2 /> Delete
          </Button>
          {pending && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
        </div>
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
        onRowSelectionChange={setRowSelection}
        onRowClick={(t) => setDraft({ open: true, task: t })}
        emptyText={
          state === "open" && assignee === "me" && !debounced
            ? "Nothing to do. Enjoy it."
            : "No tasks match."
        }
      />

      <TaskDrawer
        draft={draft}
        onClose={() => setDraft((d) => ({ ...d, open: false }))}
        bootstrap={bootstrap}
        onSaved={reload}
      />
      <span className="sr-only" aria-live="polite">
        {loading ? "Loading tasks" : `${total} tasks`}
      </span>
    </div>
  );
}
