import { Download } from "lucide-react";
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
import {
  fetchAccessLog,
  fetchAlerts,
  fetchApiReads,
  fetchAuthEvents,
  memberNames,
} from "@/lib/security/activity-queries";
import {
  ACCESS_ACTIONS,
  ACCESS_ENTITIES,
  ACTIVITY_VIEWS,
  parseViewFilters,
  viewQuery,
  type ViewFilters,
} from "@/lib/security/activity-view";
import { AUTH_EVENT_TYPES, describeAuthEvent } from "@/lib/security/auth-events-view";
import { createClient } from "@/lib/supabase/server";

import { AcknowledgeButton } from "./acknowledge-button";

export const metadata = { title: "Activity log" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const field = "border-input bg-background h-9 rounded-md border px-2 text-sm";

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const member = await requirePerm("settings.manage");
  const params = await searchParams;
  const vf = parseViewFilters(params);
  const supabase = await createClient(); // RLS: every table here is readable with settings.manage only
  const names = await memberNames(supabase, member.orgId);
  const tz = member.org.timezone || "UTC";
  const when = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    });
  const who = (id: string | null) => (id ? (names.get(id) ?? "Former member") : "System");

  const from = (vf.page - 1) * ACTIVITY_PAGE_SIZE;
  const range: [number, number] = [from, from + ACTIVITY_PAGE_SIZE]; // one extra row tells us there is another page
  const exportHref = vf.view === "api" ? null : `/api/settings/activity/export?${viewQuery(vf)}`;

  let hasNext = false;
  let body: React.ReactNode;

  if (vf.view === "changes") {
    const filters = parseActivityFilters(params);
    let query = supabase
      .from("audit_log")
      .select("id, user_id, action, entity, entity_id, diff, at")
      .eq("org_id", member.orgId)
      .order("at", { ascending: false })
      .order("id", { ascending: false })
      .range(range[0], range[1]);
    const since = periodStart(filters.period);
    if (since) query = query.gte("at", since);
    if (filters.entity) query = query.eq("entity", filters.entity);
    if (filters.actor) query = query.eq("user_id", filters.actor);
    if (filters.q) query = query.ilike("action", `%${filters.q}%`);
    const [{ data: rows }, { data: recent }] = await Promise.all([
      query,
      // Entity choices come from recent history so the list only offers things that exist.
      supabase
        .from("audit_log")
        .select("entity")
        .eq("org_id", member.orgId)
        .order("at", { ascending: false })
        .limit(500),
    ]);
    const entities = [...new Set((recent ?? []).map((r) => r.entity))].sort();
    const visible = (rows ?? []).slice(0, ACTIVITY_PAGE_SIZE);
    hasNext = (rows?.length ?? 0) > ACTIVITY_PAGE_SIZE;
    body = (
      <>
        <FilterForm vf={vf} names={names}>
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
        </FilterForm>
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
                {visible.length === 0 && <EmptyRow cols={4} />}
                {visible.map((r) => {
                  const preview = diffPreview(r.diff);
                  return (
                    <TableRow key={r.id} className="align-top">
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        <time dateTime={r.at}>{when(r.at)}</time>
                      </TableCell>
                      <TableCell className="text-sm">{who(r.user_id)}</TableCell>
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
      </>
    );
  } else if (vf.view === "logins") {
    const rows = await fetchAuthEvents(supabase, member.orgId, vf, range);
    const visible = rows.slice(0, ACTIVITY_PAGE_SIZE);
    hasNext = rows.length > ACTIVITY_PAGE_SIZE;
    body = (
      <>
        <FilterForm vf={vf} names={names}>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Event
            <select name="type" defaultValue={vf.type ?? ""} className={field}>
              <option value="">All events</option>
              {AUTH_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {describeAuthEvent(t).label}
                </option>
              ))}
            </select>
          </label>
        </FilterForm>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead className="hidden md:table-cell">Device</TableHead>
                  <TableHead className="hidden lg:table-cell">Address</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && <EmptyRow cols={5} />}
                {visible.map((r) => {
                  const d = describeAuthEvent(r.event_type, r.method);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {when(r.at)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.user_id ? who(r.user_id) : "Unknown e-mail"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={d.tone}>{d.label}</Badge>
                      </TableCell>
                      <TableCell className="hidden text-sm md:table-cell">
                        {r.ua_family ?? "Unknown device"}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden font-mono text-xs lg:table-cell">
                        {r.ip_address ??
                          (r.ip_hash ? `anonymised · ${r.ip_hash.slice(0, 6)}` : "not recorded")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-xs">
          Full IP addresses are kept for 30 days, then only an anonymous fingerprint remains. Failed
          sign-ins for an e-mail that is not a member are not shown here.
        </p>
      </>
    );
  } else if (vf.view === "access") {
    const rows = await fetchAccessLog(supabase, member.orgId, vf, range);
    const visible = rows.slice(0, ACTIVITY_PAGE_SIZE);
    hasNext = rows.length > ACTIVITY_PAGE_SIZE;
    body = (
      <>
        <FilterForm vf={vf} names={names}>
          <label className="flex flex-col gap-1 text-xs font-medium">
            What
            <select name="entity" defaultValue={vf.entity ?? ""} className={field}>
              <option value="">Everything</option>
              {ACCESS_ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {describeAction(e)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            How
            <select name="action" defaultValue={vf.action ?? ""} className={field}>
              <option value="">Any</option>
              {ACCESS_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {describeAction(a)}
                </option>
              ))}
            </select>
          </label>
        </FilterForm>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead className="hidden md:table-cell">Record</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && <EmptyRow cols={4} />}
                {visible.map((r) => {
                  const count = (r.detail as { rows?: unknown } | null)?.rows;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {when(r.at)}
                      </TableCell>
                      <TableCell className="text-sm">{who(r.user_id)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={r.action === "export" ? "warning" : "secondary"}>
                            {describeAction(r.action)}
                          </Badge>
                          <span className="text-sm">{describeAction(r.entity)}</span>
                          {r.sampled && <Badge variant="outline">sampled list</Badge>}
                          {typeof count === "number" && (
                            <span className="text-muted-foreground text-xs">{count} rows</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                        {r.entity_id ? r.entity_id.slice(0, 13) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-xs">
          Opening one patient, conversation, claim or file, and every export, is always recorded.
          List and search screens are sampled. The log holds record ids only, never names or message
          text.
        </p>
      </>
    );
  } else if (vf.view === "alerts") {
    const rows = await fetchAlerts(supabase, member.orgId, vf, range);
    const visible = rows.slice(0, ACTIVITY_PAGE_SIZE);
    hasNext = rows.length > ACTIVITY_PAGE_SIZE;
    body = (
      <>
        <FilterForm vf={vf} names={names} hideActor />
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead>Alert</TableHead>
                  <TableHead>About</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && <EmptyRow cols={4} />}
                {visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {when(r.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant={r.acknowledged_at ? "outline" : "warning"}
                          className="w-fit"
                        >
                          {describeAction(r.kind)}
                        </Badge>
                        <span className="text-sm">{r.summary}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{r.user_id ? who(r.user_id) : "—"}</TableCell>
                    <TableCell>
                      {r.acknowledged_at ? (
                        <span className="text-muted-foreground text-xs">Reviewed</span>
                      ) : (
                        <AcknowledgeButton id={r.id} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-xs">
          Alerts also appear in the notification bell for everyone with settings access. Thresholds
          are under Settings → Security.
        </p>
      </>
    );
  } else {
    const rows = await fetchApiReads(supabase, member.orgId, vf, range);
    const visible = rows.slice(0, ACTIVITY_PAGE_SIZE);
    hasNext = rows.length > ACTIVITY_PAGE_SIZE;
    const { data: keys } = await supabase
      .from("api_keys")
      .select("id, name, key_prefix")
      .eq("org_id", member.orgId);
    const keyName = new Map((keys ?? []).map((k) => [k.id, `${k.name} (${k.key_prefix}…)`]));
    body = (
      <>
        <FilterForm vf={vf} names={names} hideActor />
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Hour</TableHead>
                  <TableHead>API key</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Rows read</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && <EmptyRow cols={5} />}
                {visible.map((r) => (
                  <TableRow key={`${r.api_key_id}${r.resource}${r.bucket}`}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {when(r.bucket)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {keyName.get(r.api_key_id) ?? "Removed key"}
                    </TableCell>
                    <TableCell className="text-sm">{describeAction(r.resource)}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {r.request_count}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{r.row_count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-xs">
          Reads through the public API are counted per key, resource and hour. Individual records
          are not listed.
        </p>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity log"
        description="Who changed what, who signed in, who opened patient records, and security alerts. Entries cannot be edited or deleted."
      >
        {exportHref && (
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} download>
              <Download /> Export CSV
            </a>
          </Button>
        )}
      </PageHeader>

      <nav className="flex flex-wrap gap-1" aria-label="Activity views">
        {ACTIVITY_VIEWS.map((v) => (
          <Button
            key={v.value}
            asChild
            size="sm"
            variant={vf.view === v.value ? "default" : "ghost"}
          >
            <Link href={`/settings/activity?view=${v.value}`}>{v.label}</Link>
          </Button>
        ))}
      </nav>

      {body}

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {vf.page} · times in {tz}
        </span>
        <div className="flex gap-2">
          {vf.page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/settings/activity?${pageQuery(params, vf, vf.page - 1)}`}>Newer</Link>
            </Button>
          )}
          {hasNext && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/settings/activity?${pageQuery(params, vf, vf.page + 1)}`}>Older</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Keeps every current filter (including the Changes tab's own) when moving between pages. */
function pageQuery(params: SearchParams, vf: ViewFilters, page: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value && k !== "page") p.set(k, value);
  }
  p.set("view", vf.view);
  if (page > 1) p.set("page", String(page));
  return p.toString();
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="text-muted-foreground py-10 text-center">
        Nothing matches these filters.
      </TableCell>
    </TableRow>
  );
}

function FilterForm({
  vf,
  names,
  hideActor = false,
  children,
}: {
  vf: ViewFilters;
  names: Map<string, string>;
  hideActor?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="view" value={vf.view} />
      <label className="flex flex-col gap-1 text-xs font-medium">
        Period
        <select name="period" defaultValue={vf.period} className={field}>
          {ACTIVITY_PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {!hideActor && (
        <label className="flex flex-col gap-1 text-xs font-medium">
          Who
          <select name="actor" defaultValue={vf.actor ?? ""} className={field}>
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
      )}
      {children}
      <Button type="submit" size="sm">
        Apply
      </Button>
      <Button asChild variant="ghost" size="sm">
        <Link href={`/settings/activity?view=${vf.view}`}>Reset</Link>
      </Button>
    </form>
  );
}
