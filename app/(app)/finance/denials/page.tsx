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
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import {
  ACTIVE_STATUSES,
  CASE_STATUSES,
  CATEGORY_LABELS,
  deadlineCountdown,
  STATUS_LABELS,
  type CaseStatus,
  type DenialCategory,
} from "@/lib/finance/denials";
import { money } from "@/lib/finance/format";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createClient } from "@/lib/supabase/server";

import { SyncButton } from "./denial-controls";

import { exportQuery } from "@/lib/finance/list-exports";

export const metadata = { title: "Denials" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
type Search = {
  q?: string;
  status?: string;
  payer?: string;
  mine?: string;
  due?: string;
  page?: string;
};
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 60);

export default async function DenialsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.denials.manage");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const settings = await loadFinanceSettings(supabase, member.orgId);
  const today = todayIn(member.org.timezone);

  let query = supabase
    .from("ins_denial_cases")
    .select(
      "id, claim_number, invoice_no, cpt_code, payer_id, reason_code, category, rejected_amount, status, denied_on, deadline_on, owner_user_id",
      { count: "exact" },
    )
    .order("deadline_on", { ascending: true })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if ((CASE_STATUSES as readonly string[]).includes(sp.status ?? ""))
    query = query.eq("status", sp.status as string);
  else if (sp.status !== "all") query = query.in("status", ACTIVE_STATUSES as unknown as string[]);
  if (safe(sp.payer)) query = query.eq("payer_id", safe(sp.payer));
  if (safe(sp.q))
    query = query.or(
      `claim_number.ilike.%${safe(sp.q)}%,invoice_no.ilike.%${safe(sp.q)}%,reason_code.ilike.%${safe(sp.q)}%`,
    );
  if (sp.mine === "1") query = query.eq("owner_user_id", member.userId);
  if (sp.due === "1")
    query = query
      .lte(
        "deadline_on",
        new Date(Date.parse(`${today}T00:00:00Z`) + settings.denialWarnDays * 86_400_000)
          .toISOString()
          .slice(0, 10),
      )
      .in("status", ["open", "in_progress"]);
  const [{ data, count }, { data: people }] = await Promise.all([
    query,
    supabase.from("profiles").select("id, first_name, last_name"),
  ]);
  const names = new Map(
    (people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim() || "—"]),
  );
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) =>
    `/finance/denials?${new URLSearchParams(Object.entries({ ...sp, page: String(p) }).filter(([, v]) => v) as [string, string][]).toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Denials"
        description={`${total.toLocaleString()} case(s). Each denied claim becomes a case with an owner and a resubmission deadline; draft an appeal letter from the case (drafts only, never sent by Pulse).`}
      >
        <SyncButton />
        {total > 0 && (
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/finance/denials/export${exportQuery(sp, ["q", "status", "payer", "mine", "due"])}`}
            >
              Excel
            </a>
          </Button>
        )}
      </PageHeader>
      {!settings.denialCasesStartDate && (
        <Card>
          <CardContent className="pt-6 text-sm">
            Denial cases are switched off. Set <strong>Open denial cases from</strong> in Finance,
            Workflow settings; denials before that date are never turned into cases.
          </CardContent>
        </Card>
      )}
      <form className="grid gap-2 sm:grid-cols-6">
        <Input
          name="q"
          placeholder="Claim, invoice or denial code"
          defaultValue={sp.q}
          className="sm:col-span-2"
        />
        <Input name="payer" placeholder="Payer ID" defaultValue={sp.payer} />
        <select
          name="status"
          defaultValue={sp.status ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Being worked</option>
          <option value="all">Every status</option>
          {CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === "1"} /> Mine
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="due" value="1" defaultChecked={sp.due === "1"} /> Deadline
          close
        </label>
        <Button type="submit" variant="secondary" className="sm:col-span-6 sm:w-fit">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent className="pt-6">
          {(data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No denial cases to show.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Deadline</TableHead>
                  <TableHead>Claim</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Denied</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((c) => {
                  const active = c.status === "open" || c.status === "in_progress";
                  const cd = deadlineCountdown(c.deadline_on, today, settings.denialWarnDays);
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="text-xs">
                        {c.deadline_on}
                        {active && cd.state !== "ok" && (
                          <Badge
                            variant={cd.state === "overdue" ? "destructive" : "warning"}
                            className="ml-2"
                          >
                            {cd.label}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/finance/denials/${c.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {c.claim_number}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{c.payer_id ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {c.reason_code ?? "—"}{" "}
                        <span className="text-muted-foreground">
                          {CATEGORY_LABELS[c.category as DenialCategory]}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(c.rejected_amount)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{STATUS_LABELS[c.status as CaseStatus]}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {c.owner_user_id ? (
                          (names.get(c.owner_user_id) ?? "—")
                        ) : (
                          <span className="text-muted-foreground">Unassigned</span>
                        )}
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
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page - 1)}>Previous</Link>
            </Button>
          )}
          {page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page + 1)}>Next</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
