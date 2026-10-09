import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { requirePerm } from "@/lib/auth/session";
import { holds, isOverdue, RULE_INFO, STATUS_LABEL } from "@/lib/finance/rules";
import { createClient } from "@/lib/supabase/server";

import { ActionButton, RowForm } from "../../reference/row-form";
import { assignException, closeException, commentException, startException } from "../actions";

export const metadata = { title: "Exception" };
export const dynamic = "force-dynamic";

export default async function ExceptionDetail({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("finance.exceptions.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: ex } = await supabase.from("ops_exceptions").select("*").eq("id", id).maybeSingle();
  if (!ex) notFound();

  const [{ data: comments }, { data: people }, { data: assignable }] = await Promise.all([
    supabase
      .from("ops_exception_comments")
      .select("id, user_id, comment, created_at")
      .eq("exception_id", id)
      .order("created_at"),
    supabase.from("profiles").select("id, first_name, last_name"),
    supabase.from("memberships").select("user_id, roles(permissions)").eq("status", "active"),
  ]);
  const names = new Map(
    (people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim() || "—"]),
  );
  const candidates = (assignable ?? []).filter((m) => {
    const perms = Array.isArray(m.roles?.permissions)
      ? (m.roles.permissions as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    return holds(perms, "finance.exceptions.manage");
  });

  // where the item lives, if this member may open it
  let entityHref: string | null = null;
  if (ex.entity_type === "invoice") {
    const { data } = await supabase
      .from("fin_invoices")
      .select("id")
      .eq("inv_display_number", ex.entity_key)
      .maybeSingle();
    if (data) entityHref = `/finance/invoices/${data.id}`;
  } else if (ex.entity_type === "claim") {
    const { data } = await supabase
      .from("ins_claim_activities")
      .select("id")
      .eq("claim_activity_number", ex.entity_key)
      .maybeSingle();
    if (data) entityHref = `/finance/claims/${data.id}`;
  }

  const active = ex.status === "open" || ex.status === "in_progress";
  const late = isOverdue(ex.due_date, ex.status);
  const info = RULE_INFO[ex.rule_code];
  const detail = (ex.detail ?? {}) as Record<string, unknown>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${ex.rule_code}: ${info?.title ?? "Exception"}`}
        description={ex.entity_key}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/finance/exceptions">Back to queue</Link>
        </Button>
        {entityHref && (
          <Button asChild size="sm">
            <Link href={entityHref}>Open {ex.entity_type}</Link>
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap gap-2">
        <Badge variant={active ? "warning" : "secondary"}>
          {STATUS_LABEL[ex.status] ?? ex.status}
        </Badge>
        <Badge variant="outline">owner: {ex.owner_role}</Badge>
        {ex.branch_code && <Badge variant="outline">branch {ex.branch_code}</Badge>}
        {ex.due_date && <Badge variant={late ? "destructive" : "outline"}>due {ex.due_date}</Badge>}
        {ex.assignee_user_id && (
          <Badge variant="secondary">{names.get(ex.assignee_user_id) ?? "assigned"}</Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What this means</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>{info?.meaning}</p>
          <p>
            <strong>What to do:</strong> {info?.action}
          </p>
          {Object.keys(detail).length > 0 && (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              {Object.entries(detail).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k.replaceAll("_", " ")}</dt>
                  <dd>{String(v ?? "—")}</dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>

      {active && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Work on it</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {ex.status === "open" && (
                <ActionButton action={startException.bind(null, ex.id)}>
                  Take it (in progress)
                </ActionButton>
              )}
              <RowForm action={assignException} label="Assign">
                <input type="hidden" name="id" value={ex.id} />
                <select
                  name="assignee"
                  defaultValue={ex.assignee_user_id ?? ""}
                  className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                >
                  <option value="">Unassigned</option>
                  {candidates.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {names.get(m.user_id) ?? m.user_id.slice(0, 8)}
                      {m.user_id === member.userId ? " (me)" : ""}
                    </option>
                  ))}
                </select>
              </RowForm>
            </div>
            <RowForm
              action={closeException}
              label="Close with note"
              className="flex flex-col gap-2"
            >
              <input type="hidden" name="id" value={ex.id} />
              <Textarea name="note" placeholder="Why is this resolved? (required)" rows={2} />
            </RowForm>
          </CardContent>
        </Card>
      )}

      {!active && ex.closure_note && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Closure</CardTitle>
            <CardDescription>
              {ex.closed_at ? new Date(ex.closed_at).toLocaleString() : ""}{" "}
              {ex.closed_by ? `by ${names.get(ex.closed_by) ?? "—"}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">{ex.closure_note}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comments</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(comments ?? []).length === 0 && (
            <p className="text-muted-foreground text-sm">No comments yet.</p>
          )}
          {(comments ?? []).map((c) => (
            <div key={c.id} className="border-l-2 pl-3 text-sm">
              <div className="text-muted-foreground text-xs">
                {names.get(c.user_id ?? "") ?? "—"} · {new Date(c.created_at).toLocaleString()}
              </div>
              <div className="whitespace-pre-wrap">{c.comment}</div>
            </div>
          ))}
          <RowForm
            action={commentException}
            label="Add comment"
            className="flex items-center gap-2"
          >
            <input type="hidden" name="id" value={ex.id} />
            <Input name="comment" placeholder="Add a comment" className="h-8 flex-1 text-sm" />
          </RowForm>
        </CardContent>
      </Card>
    </div>
  );
}
