import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordHistorySection } from "@/components/history/record-history";
import { Term } from "@/components/shell/term";
import { readAiSettings } from "@/lib/ai/settings";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import {
  avoidableLabel,
  CATEGORY_LABELS,
  deadlineCountdown,
  lookupDenialCode,
  NOT_CLASSIFIED,
  ORIGIN_LABELS,
  rejectionOrigin,
  STATUS_LABELS,
  type CaseStatus,
  type DenialCategory,
} from "@/lib/finance/denials";
import { loadDenialTaxonomy } from "@/lib/finance/denial-taxonomy";
import { money } from "@/lib/finance/format";
import { holds } from "@/lib/finance/rules";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createClient } from "@/lib/supabase/server";

import {
  AppealPanel,
  AssignControl,
  DraftCard,
  NoteForm,
  StatusControl,
  type DraftView,
} from "../denial-controls";

export const metadata = { title: "Denial case" };
export const dynamic = "force-dynamic";

export default async function DenialCasePage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("finance.denials.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: c } = await supabase
    .from("ins_denial_cases")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();

  const [
    { data: notes },
    { data: drafts },
    { data: people },
    { data: assignable },
    taxonomy,
    settings,
  ] = await Promise.all([
    supabase
      .from("ins_denial_notes")
      .select("id, user_id, note, created_at")
      .eq("case_id", id)
      .order("created_at"),
    supabase
      .from("ins_appeal_drafts")
      .select("id, kind, language, body, flags, status, created_at, created_by, model")
      .eq("case_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("profiles").select("id, first_name, last_name"),
    supabase.from("memberships").select("user_id, roles(permissions)").eq("status", "active"),
    loadDenialTaxonomy(supabase, member.orgId),
    loadFinanceSettings(supabase, member.orgId),
  ]);
  const names = new Map(
    (people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim() || "—"]),
  );
  const candidates = (assignable ?? [])
    .filter((m) =>
      holds(
        Array.isArray(m.roles?.permissions)
          ? (m.roles.permissions as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        "finance.denials.manage",
      ),
    )
    .map((m) => ({ id: m.user_id, name: names.get(m.user_id) ?? "—" }));
  const meaning = lookupDenialCode(c.reason_code, taxonomy);
  const origin = rejectionOrigin(c.reason_code, taxonomy);
  const today = todayIn(member.org.timezone);
  const active =
    c.status === "open" ||
    c.status === "in_progress" ||
    c.status === "appealed" ||
    c.status === "resubmitted";
  const cd = deadlineCountdown(c.deadline_on, today, settings.denialWarnDays);
  const draftViews: DraftView[] = (drafts ?? []).map((d) => ({
    id: d.id,
    kind: d.kind,
    language: d.language,
    body: d.body,
    flags: d.flags ?? [],
    status: d.status,
    created_at: d.created_at,
    author: d.created_by ? (names.get(d.created_by) ?? "—") : "System",
    model: d.model,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Denial: claim ${c.claim_number}`}
        description={`${c.payer_id ?? "No payer"}${c.invoice_no ? `, invoice ${c.invoice_no}` : ""}${c.cpt_code ? `, code ${c.cpt_code}` : ""}`}
      >
        <Link href="/finance/denials" className="text-sm underline-offset-2 hover:underline">
          All denials
        </Link>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Case</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{STATUS_LABELS[c.status as CaseStatus]}</Badge>
              {active && cd.state !== "ok" && (
                <Badge variant={cd.state === "overdue" ? "destructive" : "warning"}>
                  {cd.label}
                </Badge>
              )}
              {active && cd.state === "ok" && (
                <span className="text-muted-foreground text-xs">{cd.label}</span>
              )}
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
              <dt className="text-muted-foreground">Denial code</dt>
              <dd>{c.reason_code ?? "not stated"}</dd>
              <dt className="text-muted-foreground">Meaning</dt>
              <dd>
                {meaning?.description ?? "Not in the taxonomy"}{" "}
                {meaning ? "" : "(add it in Workflow settings)"}
              </dd>
              <dt className="text-muted-foreground">Category</dt>
              <dd>{CATEGORY_LABELS[c.category as DenialCategory]}</dd>
              <dt className="text-muted-foreground">
                <Term k="rejection-origin">Origin</Term>
              </dt>
              <dd>{origin.origin ? ORIGIN_LABELS[origin.origin] : NOT_CLASSIFIED}</dd>
              <dt className="text-muted-foreground">
                <Term k="avoidable" />
              </dt>
              <dd>{avoidableLabel(origin.avoidable)}</dd>
              <dt className="text-muted-foreground">Denied amount</dt>
              <dd className="tabular-nums">{money(c.rejected_amount)}</dd>
              <dt className="text-muted-foreground">Claimed</dt>
              <dd className="tabular-nums">{money(c.claim_net)}</dd>
              <dt className="text-muted-foreground">Denied on</dt>
              <dd>{c.denied_on}</dd>
              <dt className="text-muted-foreground">Resubmit by</dt>
              <dd>{c.deadline_on}</dd>
              <dt className="text-muted-foreground">Owner role</dt>
              <dd>{c.owner_role}</dd>
              <dt className="text-muted-foreground">Owner</dt>
              <dd>{c.owner_user_id ? (names.get(c.owner_user_id) ?? "—") : "Unassigned"}</dd>
              {c.resolution && (
                <>
                  <dt className="text-muted-foreground">Closed because</dt>
                  <dd>{c.resolution}</dd>
                </>
              )}
            </dl>
            {active && <AssignControl id={c.id} owner={c.owner_user_id} people={candidates} />}
            <StatusControl id={c.id} status={c.status as CaseStatus} />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Appeal letter</CardTitle>
              <CardDescription>
                Always a draft. You read it, complete the bracketed parts and send it yourself.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <AppealPanel
                id={c.id}
                aiEnabled={readAiSettings(member.org.settings).enabled}
                appealable={c.appealable}
              />
              {draftViews.map((d) => (
                <DraftCard key={d.id} draft={d} />
              ))}
              {draftViews.length === 0 && (
                <p className="text-muted-foreground text-sm">No drafts yet.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {(notes ?? []).map((n) => (
                <div key={n.id} className="rounded-md border p-3 text-sm">
                  <div className="text-muted-foreground mb-1 text-xs">
                    {n.user_id ? (names.get(n.user_id) ?? "—") : "—"},{" "}
                    {new Date(n.created_at).toLocaleString("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </div>
                  <p className="whitespace-pre-wrap">{n.note}</p>
                </div>
              ))}
              {(notes ?? []).length === 0 && (
                <p className="text-muted-foreground text-sm">No notes yet.</p>
              )}
              <NoteForm id={c.id} />
            </CardContent>
          </Card>
          <RecordHistorySection table="ins_denial_cases" recordId={c.id} />
        </div>
      </div>
    </div>
  );
}
