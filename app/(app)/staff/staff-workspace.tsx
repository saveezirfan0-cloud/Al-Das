"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, Clock, Loader2, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { DataGrid, type DataGridColumn } from "@/components/data-grid/data-grid";
import { useLocalGrid } from "@/components/data-grid/use-local-grid";
import { ExpiryBadge } from "@/components/organisation/expiry-badge";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { expiryBadge } from "@/lib/organisation/expiry";
import { EMPLOYMENT_LABELS } from "@/lib/organisation/staff";
import type { BranchOption, Option, StaffRow } from "@/lib/organisation/types";

import { saveReminderDaysAction } from "./actions";
import { StaffDrawer } from "./staff-drawer";

const ALL = "all";
const NO_BRANCH = "none";

export type StaffCan = { manage: boolean; rota: boolean };

export function StaffWorkspace({
  rows,
  branches,
  departments,
  members,
  specialists,
  today,
  leadDays,
  initialBranch,
  openId,
  can,
}: {
  rows: StaffRow[];
  branches: BranchOption[];
  departments: Option[];
  members: Option[];
  specialists: Option[];
  today: string;
  leadDays: number;
  initialBranch: string | null;
  openId: string | null;
  can: StaffCan;
}) {
  const [search, setSearch] = React.useState("");
  const [branch, setBranch] = React.useState<string>(initialBranch ?? ALL);
  const [showArchived, setShowArchived] = React.useState(false);
  const [onlyExpiring, setOnlyExpiring] = React.useState(false);
  const [drawer, setDrawer] = React.useState<{ open: boolean; id: string | null }>({
    open: !!openId,
    id: openId,
  });
  const [daysOpen, setDaysOpen] = React.useState(false);

  const flagged = React.useCallback(
    (r: StaffRow) =>
      [r.visaExpiresOn, r.licenceExpiresOn].some((d) => {
        const s = expiryBadge(d, today, leadDays).state;
        return s === "soon" || s === "expired";
      }),
    [today, leadDays],
  );

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (showArchived || !r.archived) &&
        (branch === ALL ||
          (branch === NO_BRANCH ? !r.homeLocationId : r.homeLocationId === branch)) &&
        (!onlyExpiring || flagged(r)) &&
        (!term ||
          r.fullName.toLowerCase().includes(term) ||
          (r.jobTitle ?? "").toLowerCase().includes(term) ||
          (r.departmentName ?? "").toLowerCase().includes(term)),
    );
  }, [rows, search, branch, showArchived, onlyExpiring, flagged]);

  const sortBy = React.useMemo(
    () => ({
      name: (r: StaffRow) => r.fullName,
      title: (r: StaffRow) => r.jobTitle,
      department: (r: StaffRow) => r.departmentName,
      branch: (r: StaffRow) => r.homeLocationName,
      manager: (r: StaffRow) => r.managerName,
      type: (r: StaffRow) => EMPLOYMENT_LABELS[r.employmentType],
      expiry: (r: StaffRow) =>
        [r.visaExpiresOn, r.licenceExpiresOn].filter(Boolean).sort()[0] ?? null,
    }),
    [],
  );
  const grid = useLocalGrid(filtered, sortBy, [{ id: "name", desc: false }]);

  const columns = React.useMemo<DataGridColumn<StaffRow>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        header: "Name",
        sortKey: "name",
        locked: true,
        size: 220,
        cell: ({ row }) => (
          <span className="flex items-center gap-2 truncate font-medium">
            {row.original.fullName}
            {row.original.archived && <Badge variant="outline">Archived</Badge>}
          </span>
        ),
      },
      {
        id: "title",
        label: "Job title",
        header: "Job title",
        sortKey: "title",
        cell: ({ row }) => row.original.jobTitle ?? "—",
      },
      {
        id: "department",
        label: "Department",
        header: "Department",
        sortKey: "department",
        cell: ({ row }) => row.original.departmentName ?? "—",
      },
      {
        id: "branch",
        label: "Home branch",
        header: "Home branch",
        sortKey: "branch",
        cell: ({ row }) => row.original.homeLocationName ?? "—",
      },
      {
        id: "manager",
        label: "Manager",
        header: "Manager",
        sortKey: "manager",
        cell: ({ row }) => row.original.managerName ?? "—",
      },
      {
        id: "type",
        label: "Employment",
        header: "Employment",
        sortKey: "type",
        size: 130,
        cell: ({ row }) => EMPLOYMENT_LABELS[row.original.employmentType],
      },
      {
        id: "expiry",
        label: "Visa and licence",
        header: "Visa and licence",
        sortKey: "expiry",
        size: 280,
        cell: ({ row }) => {
          const r = row.original;
          const badges = [
            <ExpiryBadge
              key="v"
              label="Visa"
              date={r.visaExpiresOn}
              today={today}
              leadDays={leadDays}
            />,
            <ExpiryBadge
              key="l"
              label="Licence"
              date={r.licenceExpiresOn}
              today={today}
              leadDays={leadDays}
            />,
          ];
          return flagged(r) ? (
            <span className="flex flex-wrap gap-1">{badges}</span>
          ) : (
            <span className="text-muted-foreground">
              {r.visaExpiresOn || r.licenceExpiresOn ? "Up to date" : "—"}
            </span>
          );
        },
      },
    ],
    [today, leadDays, flagged],
  );

  const expiringCount = rows.filter((r) => !r.archived && flagged(r)).length;
  const current = drawer.id ? (rows.find((r) => r.id === drawer.id) ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Staff"
        description="Everyone who works at the clinic: job, department, home branch, manager, duties and shifts. Pay stays in Finance."
      >
        {can.rota && (
          <Button asChild variant="outline">
            <Link href="/staff/rota">
              <Clock aria-hidden /> Rota
            </Link>
          </Button>
        )}
        {can.manage && (
          <Button variant="outline" onClick={() => setDaysOpen(true)}>
            <BellRing aria-hidden /> Reminder days ({leadDays})
          </Button>
        )}
        {can.manage && (
          <Button onClick={() => setDrawer({ open: true, id: null })}>
            <UserPlus aria-hidden /> Add staff member
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            aria-hidden
            className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            aria-label="Search staff"
            placeholder="Search name, title or department"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {branches.length > 0 && (
          <OptionSelect
            id="staff-branch"
            className="w-48"
            allowNone={false}
            value={branch}
            options={[
              { value: ALL, label: "All my branches" },
              ...branches.map((b) => ({ value: b.id, label: b.name })),
              { value: NO_BRANCH, label: "No home branch" },
            ]}
            onChange={(v) => setBranch(v ?? ALL)}
          />
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={onlyExpiring}
            onChange={(e) => setOnlyExpiring(e.target.checked)}
          />
          Expiring or expired only{expiringCount > 0 ? ` (${expiringCount})` : ""}
        </label>
        {can.manage && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        )}
      </div>

      <DataGrid
        columns={columns}
        {...grid}
        onRowClick={(r) => setDrawer({ open: true, id: r.id })}
        emptyText={
          rows.length === 0
            ? can.manage
              ? "No staff yet. Use Add staff member to start the directory."
              : "No staff records yet."
            : "No one matches these filters."
        }
      />

      <StaffDrawer
        open={drawer.open}
        staff={current}
        onClose={() => setDrawer({ open: false, id: null })}
        onCreated={(id) => setDrawer({ open: true, id })}
        rows={rows}
        branches={branches}
        departments={departments}
        members={members}
        specialists={specialists}
        today={today}
        leadDays={leadDays}
        can={can}
      />

      {can.manage && (
        <ReminderDaysDialog open={daysOpen} onOpenChange={setDaysOpen} current={leadDays} />
      )}
    </div>
  );
}

function ReminderDaysDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: number;
}) {
  const router = useRouter();
  const [days, setDays] = React.useState(String(current));
  const [pending, startTransition] = React.useTransition();
  React.useEffect(() => {
    if (open) setDays(String(current));
  }, [open, current]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Visa and licence reminders</DialogTitle>
          <DialogDescription>
            People who manage staff get one reminder a day listing visas and licences (staff and
            doctors) that expire within this many days. The lists show the same window.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="lead-days">Days before expiry</Label>
          <Input
            id="lead-days"
            type="number"
            min={1}
            max={180}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await saveReminderDaysAction(Number(days));
                if (!res.ok) return void toast.error(res.error);
                toast.success(res.message ?? "Saved.");
                onOpenChange(false);
                router.refresh();
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
