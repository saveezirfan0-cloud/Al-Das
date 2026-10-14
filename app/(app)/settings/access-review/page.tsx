import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import { quarterOf, type ReviewEntry } from "@/lib/security/access-review";
import { createAdminClient } from "@/lib/supabase/admin";

import { ReviewBoard, StartReviewButton } from "./review-board";

export const metadata = { title: "Access review" };
export const dynamic = "force-dynamic";

export default async function AccessReviewPage() {
  const member = await requirePerm("security.manage");
  const admin = createAdminClient();
  const { data: reviews } = await admin
    .from("access_reviews")
    .select(
      "id, period, status, snapshot, opened_at, attested_at, attestation_name, attestation_note, signature",
    )
    .eq("org_id", member.orgId)
    .order("period", { ascending: false })
    .limit(12);

  const current = quarterOf(new Date());
  const open = (reviews ?? []).find((r) => r.status === "open");
  const signedThisQuarter = (reviews ?? []).some(
    (r) => r.period === current && r.status === "attested",
  );
  const past = (reviews ?? []).filter((r) => r.status === "attested");
  const hasCurrent = (reviews ?? []).some((r) => r.period === current);
  const tz = member.org.timezone || "UTC";
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: tz, dateStyle: "medium" }) : "";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Access review"
        description="Once a quarter, look at everyone who can sign in, what they can do, and whether they still need it. Then sign it off."
      >
        {!hasCurrent && <StartReviewButton period={current} />}
      </PageHeader>

      {!signedThisQuarter && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          The review for <b>{current}</b> has not been signed yet.
          {open ? " It is open below." : " Start it with the button above."}
        </p>
      )}

      {open && (
        <ReviewBoard
          reviewId={open.id}
          period={open.period}
          entries={Array.isArray(open.snapshot) ? (open.snapshot as unknown as ReviewEntry[]) : []}
          selfUserId={member.userId}
          signerName={
            `${member.profile.first_name} ${member.profile.last_name}`.trim() ||
            member.user.email ||
            ""
          }
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Signed reviews</CardTitle>
          <CardDescription>
            A signed review cannot be edited. The signature is a hash of who was reviewed, the
            decisions and the signer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {past.length === 0 ? (
            <EmptyState
              title="No review has been signed yet"
              description="Go through the list above and sign it off once a quarter."
            />
          ) : (
            <ul className="divide-y">
              {past.map((r) => {
                const entries = Array.isArray(r.snapshot)
                  ? (r.snapshot as unknown as ReviewEntry[])
                  : [];
                return (
                  <li key={r.id} className="flex flex-col gap-1 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{r.period}</b>
                      <Badge variant="success">Signed {fmt(r.attested_at)}</Badge>
                      <span className="text-muted-foreground">by {r.attestation_name}</span>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {entries.length} people ·{" "}
                      {entries.filter((e) => e.decision === "keep").length} kept ·{" "}
                      {entries.filter((e) => e.decision === "revoke").length} to revoke
                      {r.attestation_note ? ` · “${r.attestation_note}”` : ""}
                    </div>
                    <code className="text-muted-foreground text-[11px] break-all">
                      {r.signature}
                    </code>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
