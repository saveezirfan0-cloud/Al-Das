import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { isOverdue, RULE_CODES, RULE_INFO, STATUS_LABEL } from "@/lib/finance/rules";
import { createClient } from "@/lib/supabase/server";

import { ActionButton } from "../reference/row-form";
import { runRulesNow } from "./actions";

export const metadata = { title: "Exceptions" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
type Search = {
  rule?: string;
  branch?: string;
  status?: string;
  overdue?: string;
  mine?: string;
  page?: string;
};

const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 40);

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.exceptions.manage");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = ["open", "in_progress", "closed", "auto_closed", "all"].includes(sp.status ?? "")
    ? (sp.status as string)
    : "active";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createClient(); // RLS: only the queues this member owns

  let q = supabase
    .from("ops_exceptions")
    .select(
      "id, rule_code, entity_type, entity_key, branch_code, owner_role, status, due_date, opened_at, assignee_user_id",
      { count: "exact" },
    )
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("opened_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (status === "active") q = q.in("status", ["open", "in_progress"]);
  else if (status !== "all") q = q.eq("status", status);
  if (RULE_CODES.includes(sp.rule ?? "")) q = q.eq("rule_code", sp.rule as string);
  if (safe(sp.branch)) q = q.eq("branch_code", safe(sp.branch));
  if (sp.overdue === "1") q = q.lt("due_date", today).in("status", ["open", "in_progress"]);
  if (sp.mine === "1") q = q.eq("assignee_user_id", member.userId);
  else if (sp.mine === "0") q = q.is("assignee_user_id", null);

  const [{ data, count }, { data: people }, { data: openByRule }] = await Promise.all([
    q,
    supabase.from("profiles").select("id, first_name, last_name"),
    supabase
      .from("ops_exceptions")
      .select("rule_code, due_date, status")
      .in("status", ["open", "in_progress"])
      .limit(20_000),
  ]);
  const names = new Map(
    (people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim() || "—"]),
  );
  const tally = new Map<string, { open: number; overdue: number }>();
  for (const e of openByRule ?? []) {
    const t = tally.get(e.rule_code) ?? { open: 0, overdue: 0 };
    t.open++;
    if (isOverdue(e.due_date, e.status)) t.overdue++;
    tally.set(e.rule_code, t);
  }
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (over: Partial<Search>) => {
    const params = new URLSearchParams(
      Object.entries({ ...sp, page: "1", ...over }).filter(([, v]) => v) as [string, string][],
    );
    return `/finance/exceptions?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Exceptions"
        description="Things that need a person: your queue, by rule. Each clears itself when the cause is fixed."
      >
        {can(member, "finance.capture.manage") && (
          <ActionButton action={runRulesNow}>Run rules now</ActionButton>
        )}
      </PageHeader>

      <div className="flex flex-wrap gap-2">
        {[...tally.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, t]) => (
            <Link key={code} href={link({ rule: code })}>
              <Badge
                variant={t.overdue ? "destructive" : "secondary"}
                title={RULE_INFO[code]?.title}
              >
                {code}: {t.open}
                {t.overdue ? ` (${t.overdue} overdue)` : ""}
              </Badge>
            </Link>
          ))}
        {tally.size === 0 && (
          <p className="text-muted-foreground text-sm">Nothing open in your queues.</p>
        )}
      </div>

      <form className="grid gap-2 sm:grid-cols-6">
        <select
          name="rule"
          defaultValue={sp.rule ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Any rule</option>
          {RULE_CODES.map((c) => (
            <option key={c} value={c}>
              {c} {RULE_INFO[c].title}
            </option>
          ))}
        </select>
        <Input name="branch" placeholder="Branch (P, M, G)" defaultValue={sp.branch} />
        <select
          name="status"
          defaultValue={sp.status ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Open and in progress</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="closed">Closed</option>
          <option value="auto_closed">Cleared by itself</option>
          <option value="all">All</option>
        </select>
        <select
          name="mine"
          defaultValue={sp.mine ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Anyone</option>
          <option value="1">Assigned to me</option>
          <option value="0">Unassigned</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="overdue" value="1" defaultChecked={sp.overdue === "1"} />{" "}
          Overdue only
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>

      <Card>
        <CardContent className="pt-6">
          {(data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No exceptions match.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Assigned to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((e) => {
                  const late = isOverdue(e.due_date, e.status);
                  return (
                    <TableRow key={e.id} className={late ? "bg-destructive/5" : undefined}>
                      <TableCell>
                        <Badge variant="outline" title={RULE_INFO[e.rule_code]?.title}>
                          {e.rule_code}
                        </Badge>{" "}
                        <span className="text-xs">{RULE_INFO[e.rule_code]?.title}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/finance/exceptions/${e.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {e.entity_key}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{e.branch_code ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {STATUS_LABEL[e.status] ?? e.status}
                      </TableCell>
                      <TableCell
                        className={late ? "text-destructive text-xs font-medium" : "text-xs"}
                      >
                        {e.due_date ?? "—"}
                        {late ? " (overdue)" : ""}
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.assignee_user_id ? (names.get(e.assignee_user_id) ?? "—") : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total.toLocaleString()} found. Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={link({ page: String(page - 1) })}>Previous</Link>
            </Button>
          )}
          {page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link href={link({ page: String(page + 1) })}>Next</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
