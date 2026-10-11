import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_PERIODS,
  actionTone,
  describeAction,
  diffPreview,
  parseActivityFilters,
  periodStart,
} from "@/lib/audit-view";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Activity log" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const member = await requirePerm("settings.manage");
  const filters = parseActivityFilters(await searchParams);
  const supabase = await createClient(); // RLS: audit_log is readable with settings.manage only

  const from = (filters.page - 1) * ACTIVITY_PAGE_SIZE;
  let query = supabase
    .from("audit_log")
    .select("id, user_id, action, entity, entity_id, diff, at")
    .eq("org_id", member.orgId)
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + ACTIVITY_PAGE_SIZE); // one extra row tells us there is another page
  const since = periodStart(filters.period);
  if (since) query = query.gte("at", since);
  if (filters.entity) query = query.eq("entity", filters.entity);
  if (filters.actor) query = query.eq("user_id", filters.actor);
  if (filters.q) query = query.ilike("action", `%${filters.q}%`);

  const [{ data: rows }, { data: people }, { data: recent }] = await Promise.all([
    query,
    supabase
      .from("memberships")
      .select("user_id, profiles(first_name, last_name, email)")
      .eq("org_id", member.orgId),
    // Entity choices come from recent history so the list only offers things that exist.
    supabase
      .from("audit_log")
      .select("entity")
      .eq("org_id", member.orgId)
      .order("at", { ascending: false })
      .limit(500),
  ]);

  const names = new Map(
    (people ?? []).map((m) => {
      const p = m.profiles;
      const full = p ? `${p.first_name} ${p.last_name}`.trim() : "";
      return [m.user_id, full || p?.email || "Unknown user"] as const;
    }),
  );
  const entities = [...new Set((recent ?? []).map((r) => r.entity))].sort();
  const visible = (rows ?? []).slice(0, ACTIVITY_PAGE_SIZE);
  const hasNext = (rows?.length ?? 0) > ACTIVITY_PAGE_SIZE;

  const link = (page: number) => {
    const p = new URLSearchParams();
    p.set("period", filters.period);
    if (filters.entity) p.set("entity", filters.entity);
    if (filters.actor) p.set("actor", filters.actor);
    if (filters.q) p.set("q", filters.q);
    if (page > 1) p.set("page", String(page));
    return `/settings/activity?${p.toString()}`;
  };

  const field = "border-input bg-background h-9 rounded-md border px-2 text-sm";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity log"
        description="Who changed what, and when: roles, access, channels, exports, imports and other sensitive actions. Entries cannot be edited or deleted."
      />

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Period
          <select name="period" defaultValue={filters.period} className={field}>
            {ACTIVITY_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Who
          <select name="actor" defaultValue={filters.actor ?? ""} className={field}>
            <option value="">Everyone</option>
            {[...names.entries()]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Area
          <select name="entity" defaultValue={filters.entity ?? ""} className={field}>
            <option value="">All areas</option>
            {entities.map((e) => (
              <option key={e} value={e}>
                {describeAction(e)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Action contains
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="e.g. exported"
            maxLength={64}
            className={`${field} w-44`}
          />
        </label>
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings/activity">Reset</Link>
        </Button>
      </form>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden lg:table-cell">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-10 text-center">
                    No activity matches these filters.
                  </TableCell>
                </TableRow>
              )}
              {visible.map((r) => {
                const preview = diffPreview(r.diff);
                return (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      <time dateTime={r.at}>
                        {new Date(r.at).toLocaleString("en-GB", {
                          timeZone: member.org.timezone || "UTC",
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </time>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.user_id ? (names.get(r.user_id) ?? "Former member") : "System"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={actionTone(r.action)}>{describeAction(r.action)}</Badge>
                        <span className="text-muted-foreground text-xs">
                          {describeAction(r.entity)}
                          {r.entity_id ? ` · ${r.entity_id.slice(0, 8)}` : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-md lg:table-cell">
                      {preview ? (
                        <details>
                          <summary className="text-muted-foreground cursor-pointer truncate font-mono text-xs">
                            {preview}
                          </summary>
                          <pre className="bg-muted mt-2 max-h-60 overflow-auto rounded-md p-2 text-xs">
                            {JSON.stringify(r.diff, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {filters.page} · times in {member.org.timezone || "UTC"}
        </span>
        <div className="flex gap-2">
          {filters.page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(filters.page - 1)}>Newer</Link>
            </Button>
          )}
          {hasNext && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(filters.page + 1)}>Older</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
