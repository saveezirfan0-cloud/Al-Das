import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { ERASURE_RETAINED_NOTE } from "@/lib/security/privacy";
import { createAdminClient } from "@/lib/supabase/admin";

import { NewRequestDialog, RequestActions } from "./privacy-requests";

export const metadata = { title: "Patient data requests" };
export const dynamic = "force-dynamic";

const STATUS_VARIANT = {
  pending: "warning",
  approved: "default",
  completed: "success",
  rejected: "destructive",
  cancelled: "outline",
} as const;

export default async function PrivacyPage() {
  const member = await requirePerm("privacy.manage");
  const admin = createAdminClient();
  const { data: requests } = await admin
    .from("privacy_requests")
    .select(
      "id, kind, status, reason, requested_by, requested_at, decided_by, decided_at, decision_note, completed_at, result, contact_id, contacts(full_name, erased_at)",
    )
    .eq("org_id", member.orgId)
    .order("requested_at", { ascending: false })
    .limit(100);

  const people = new Map<string, string>();
  const ids = [
    ...new Set(
      (requests ?? [])
        .flatMap((r) => [r.requested_by, r.decided_by])
        .filter((x): x is string => !!x),
    ),
  ];
  if (ids.length) {
    const { data } = await admin
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", ids);
    for (const p of data ?? [])
      people.set(p.id, `${p.first_name} ${p.last_name}`.trim() || p.email || "Someone");
  }
  const tz = member.org.timezone || "UTC";
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString("en-GB", {
          timeZone: tz,
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Patient data requests"
        description="Give a patient a copy of their data, or erase it. Every request needs a second administrator to approve it, and everything is recorded in the activity log."
      >
        <NewRequestDialog />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>What erasure does</CardTitle>
          <CardDescription>
            Name, phone numbers, e-mail, date of birth, notes, messages, attachments and timeline
            are removed or blanked, and the patient is marked as never to be messaged. Appointments,
            enquiries and tasks stay as anonymous counts. {ERASURE_RETAINED_NOTE}
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="flex flex-col gap-3">
        {(requests ?? []).length === 0 && (
          <p className="text-muted-foreground text-sm">No requests yet.</p>
        )}
        {(requests ?? []).map((r) => (
          <Card key={r.id}>
            <CardContent className="flex flex-col gap-3 pt-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{r.kind === "export" ? "Export" : "Erasure"}</Badge>
                <Badge
                  variant={STATUS_VARIANT[r.status as keyof typeof STATUS_VARIANT] ?? "outline"}
                >
                  {r.status}
                </Badge>
                <span className="font-medium">
                  {r.contacts?.erased_at
                    ? "Erased patient"
                    : r.contacts?.full_name || "Unnamed patient"}
                </span>
              </div>
              <p className="text-sm">{r.reason}</p>
              <div className="text-muted-foreground text-xs">
                Raised by{" "}
                {r.requested_by
                  ? (people.get(r.requested_by) ?? "a former member")
                  : "a former member"}{" "}
                · {when(r.requested_at)}
                {r.decided_at && (
                  <>
                    {" "}
                    · {r.status === "rejected" ? "rejected" : "approved"} by{" "}
                    {r.decided_by
                      ? (people.get(r.decided_by) ?? "a former member")
                      : "a former member"}{" "}
                    · {when(r.decided_at)}
                  </>
                )}
                {r.decision_note ? ` · “${r.decision_note}”` : ""}
              </div>
              {r.status === "completed" &&
                r.result &&
                Object.keys(r.result as object).length > 0 && (
                  <pre className="bg-muted overflow-x-auto rounded-md p-2 text-xs">
                    {JSON.stringify(r.result, null, 1)}
                  </pre>
                )}
              <RequestActions
                id={r.id}
                kind={r.kind as "export" | "erasure"}
                status={r.status as "pending" | "approved" | "completed" | "rejected" | "cancelled"}
                mine={r.requested_by === member.userId}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
