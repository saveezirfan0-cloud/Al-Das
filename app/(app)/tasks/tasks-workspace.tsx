"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TASK_TYPE_LABELS, TASK_TYPES } from "@/lib/tasks/due";
import type { TaskFilter } from "@/lib/tasks/schemas";
import type { TaskRow } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

import { loadTasks, setTaskDoneAction } from "./actions";
import { DueBadge } from "./due-badge";
import { TaskDrawer } from "./task-drawer";

type Tab = "mine" | "all" | "overdue" | "done";

const TAB_FILTER: Record<Tab, Pick<TaskFilter, "scope" | "state">> = {
  mine: { scope: "mine", state: "open" },
  all: { scope: "all", state: "open" },
  overdue: { scope: "all", state: "overdue" },
  done: { scope: "all", state: "done" },
};
const ALL = "__all";

export function TasksWorkspace({
  timezone,
  users,
  canSearchPatients,
  canLookUpEnquiries,
  canViewEnquiries,
}: {
  timezone: string;
  users: Array<{ id: string; label: string }>;
  canSearchPatients: boolean;
  canLookUpEnquiries: boolean;
  canViewEnquiries: boolean;
}) {
  const [tab, setTab] = React.useState<Tab>("mine");
  const [type, setType] = React.useState<string>(ALL);
  const [assignee, setAssignee] = React.useState<string>(ALL);
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [dueFrom, setDueFrom] = React.useState("");
  const [dueTo, setDueTo] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [rows, setRows] = React.useState<TaskRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(50);
  const [loading, setLoading] = React.useState(true);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [drawer, setDrawer] = React.useState<{ open: boolean; task: TaskRow | null }>({
    open: false,
    task: null,
  });

  React.useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(h);
  }, [search]);

  const filter = React.useMemo<TaskFilter>(
    () => ({
      ...TAB_FILTER[tab],
      type: type === ALL ? undefined : (type as TaskFilter["type"]),
      assignee_id:
        tab === "mine" || assignee === ALL ? undefined : (assignee as TaskFilter["assignee_id"]),
      due_from: dueFrom || undefined,
      due_to: dueTo || undefined,
      search: debounced || undefined,
    }),
    [tab, type, assignee, dueFrom, dueTo, debounced],
  );

  React.useEffect(() => setPage(0), [filter]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadTasks({ filter, page }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setRows(r.rows);
      setTotal(r.total);
      setPageSize(r.pageSize);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, page, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  async function toggle(t: TaskRow) {
    const r = await setTaskDoneAction(t.id, !t.done);
    if (!r.ok) toast.error(r.error);
    reload();
  }

  const pages = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="Tasks"
        description="Follow-ups and to-dos, with a notification when they fall due."
      >
        <Button size="sm" onClick={() => setDrawer({ open: true, task: null })}>
          <Plus /> New task
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="mine">My tasks</TabsTrigger>
            <TabsTrigger value="all">All open</TabsTrigger>
            <TabsTrigger value="overdue">Overdue</TabsTrigger>
            <TabsTrigger value="done">Done</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-52">
          <Search
            className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            aria-label="Search tasks"
            className="h-8 ps-8"
            placeholder="Search subject"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger size="sm" className="w-36" aria-label="Type filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {TASK_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TASK_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tab !== "mine" && (
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger size="sm" className="w-44" aria-label="Assignee filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Everyone</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          type="date"
          aria-label="Due from"
          className="h-8 w-36"
          value={dueFrom}
          onChange={(e) => setDueFrom(e.target.value)}
        />
        <Input
          type="date"
          aria-label="Due to"
          className="h-8 w-36"
          value={dueTo}
          onChange={(e) => setDueTo(e.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Task</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Assigned to</TableHead>
              <TableHead>Patient</TableHead>
              <TableHead>Enquiry</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  <Loader2 className="mx-auto size-4 animate-spin" aria-label="Loading" />
                </TableCell>
              </TableRow>
            )}
            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                  {tab === "mine" ? "Nothing on your list. Nice." : "No tasks match."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((t) => (
              <TableRow key={t.id} className={cn(t.done && "text-muted-foreground")}>
                <TableCell>
                  <Checkbox
                    aria-label={t.done ? `Reopen "${t.subject}"` : `Mark "${t.subject}" done`}
                    checked={t.done}
                    onCheckedChange={() => void toggle(t)}
                  />
                </TableCell>
                <TableCell className="max-w-80">
                  <button
                    type="button"
                    className={cn(
                      "text-start font-medium hover:underline",
                      t.done && "line-through",
                    )}
                    onClick={() => setDrawer({ open: true, task: t })}
                  >
                    {t.subject}
                  </button>
                </TableCell>
                <TableCell>{TASK_TYPE_LABELS[t.type]}</TableCell>
                <TableCell>
                  <DueBadge task={t} timezone={timezone} />
                </TableCell>
                <TableCell>
                  {t.assignee_name || <span className="text-muted-foreground">Unassigned</span>}
                </TableCell>
                <TableCell>{t.patient}</TableCell>
                <TableCell>
                  {t.enquiry_id && t.enquiry_number !== null ? (
                    canViewEnquiries ? (
                      <Link className="underline" href={`/enquiries?enquiry=${t.enquiry_id}`}>
                        #{t.enquiry_number}
                      </Link>
                    ) : (
                      `#${t.enquiry_number}`
                    )
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total} task{total === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous page"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular-nums">
            {page + 1} / {pages}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next page"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <TaskDrawer
        open={drawer.open}
        task={drawer.task}
        users={users}
        timezone={timezone}
        canSearchPatients={canSearchPatients}
        canLookUpEnquiries={canLookUpEnquiries}
        onOpenChange={(o) => setDrawer((d) => ({ ...d, open: o }))}
        onSaved={reload}
      />
    </div>
  );
}
