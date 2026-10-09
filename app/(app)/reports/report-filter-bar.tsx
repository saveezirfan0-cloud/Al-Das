"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { filtersToSearchParams, PERIOD_LABELS, PERIODS, type Period, type ReportFilters } from "@/lib/reports/filters";
import type { FilterKind } from "@/lib/reports/types";

type Options = Record<"channels" | "teams" | "users", Array<{ value: string; label: string }>>;

/**
 * The shared filter row, one place above the charts. State lives in the URL: changing a control
 * navigates, so the page is shareable and the CSV export matches what is on screen.
 */
export function ReportFilterBar({ filters, applicable, options }: { filters: ReportFilters; applicable: FilterKind[]; options: Options }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();

  function apply(next: ReportFilters) {
    const qs = filtersToSearchParams(next).toString();
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  return (
    <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Report filters">
      <div className="grid gap-1.5">
        <Label>Period</Label>
        <Select
          value={filters.period}
          onValueChange={(v) => {
            const period = v as Period;
            if (period !== "custom") return apply({ ...filters, period, from: undefined, to: undefined });
            // A custom range needs both dates to be valid, so start from the last 30 days.
            const to = new Date();
            const from = new Date(to.getTime() - 29 * 86_400_000);
            apply({ ...filters, period, from: filters.from ?? ymd(from), to: filters.to ?? ymd(to) });
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filters.period === "custom" && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-from">From</Label>
            <Input id="rf-from" type="date" className="w-40" defaultValue={filters.from} onChange={(e) => e.target.value && apply({ ...filters, from: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rf-to">To</Label>
            <Input id="rf-to" type="date" className="w-40" defaultValue={filters.to} onChange={(e) => e.target.value && apply({ ...filters, to: e.target.value })} />
          </div>
        </>
      )}

      {applicable.includes("channel") && options.channels.length > 0 && (
        <div className="grid w-52 gap-1.5">
          <Label>WhatsApp number</Label>
          <MultiSelect options={options.channels} value={filters.channel_ids} onChange={(v) => apply({ ...filters, channel_ids: v })} placeholder="All numbers" />
        </div>
      )}
      {applicable.includes("team") && options.teams.length > 0 && (
        <div className="grid w-52 gap-1.5">
          <Label>Team</Label>
          <MultiSelect options={options.teams} value={filters.team_ids} onChange={(v) => apply({ ...filters, team_ids: v })} placeholder="All teams" />
        </div>
      )}
      {applicable.includes("user") && options.users.length > 0 && (
        <div className="grid w-52 gap-1.5">
          <Label>Staff member</Label>
          <MultiSelect options={options.users} value={filters.user_ids} onChange={(v) => apply({ ...filters, user_ids: v })} placeholder="Everyone" />
        </div>
      )}
      {pending && <Loader2 className="text-muted-foreground mb-2 size-4 animate-spin" aria-label="Updating" />}
    </div>
  );
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
