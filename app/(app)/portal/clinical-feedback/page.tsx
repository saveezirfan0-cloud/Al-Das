import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
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
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Clinical feedback" };

const LIMIT = 200;

const STAGE: Record<string, string> = {
  day3_antibiotics: "Day 3 of antibiotics",
  after_antibiotics: "After antibiotics",
  after_probiotics: "After probiotics",
  post_procedure: "After a procedure",
};

/**
 * Portal → Clinical feedback (replaces the Acute base's Feedback & Outcomes table): patient replies to clinical
 * check-ins with the parsed score, side-effect and red-flag markers and whether the doctor and the care
 * coordinator were told (R-16 .. R-19). Read-only; the work itself happens in the Follow-Up Queue. The reply
 * text is health data and is only shown when someone opens it.
 */
export default async function ClinicalFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("portal.clinical_followups.read");
  const sp = await searchParams;
  const reviewOnly = sp.review === "1";
  const admin = createAdminClient();
  const showNames = can(member, "contacts.view");

  let query = admin
    .from("clinical_feedback")
    .select(
      "id, ref, contact_id, stage, score, reply_text, side_effects_flagged, needs_doctor_review, red_flag_threshold_used, doctor_notified_at, coordinator_notified_at, is_test_record, created_at",
      { count: "exact" },
    )
    .eq("org_id", member.orgId)
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (reviewOnly) query = query.eq("needs_doctor_review", true);
  const { data, count } = await query;
  const rows = data ?? [];

  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const { data: contacts } =
    showNames && contactIds.length
      ? await admin
          .from("contacts")
          .select("id, full_name")
          .eq("org_id", member.orgId)
          .in("id", contactIds)
      : { data: [] as Array<{ id: string; full_name: string | null }> };
  const nameById = new Map((contacts ?? []).map((c) => [c.id, c.full_name]));

  await recordAccess(admin, member, {
    entity: "portal_record",
    action: "list",
    detail: { screen: "clinical_feedback", rows: rows.length, review_only: reviewOnly },
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clinical feedback"
        description="What patients answered to clinical check-ins: the score, side effects and whether a doctor was alerted. Calls and outcomes are recorded in Clinical follow-ups."
      />
      <nav aria-label="Filter" className="flex gap-3 text-sm">
        <Link
          href="/portal/clinical-feedback"
          className={reviewOnly ? "text-primary underline" : "font-semibold"}
          aria-current={reviewOnly ? undefined : "page"}
        >
          All replies
        </Link>
        <Link
          href="/portal/clinical-feedback?review=1"
          className={reviewOnly ? "font-semibold" : "text-primary underline"}
          aria-current={reviewOnly ? "page" : undefined}
        >
          Needing a person
        </Link>
      </nav>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {reviewOnly
            ? "No reply is waiting for a person."
            : "No patient feedback has been recorded yet."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Stage</TableHead>
                {showNames && <TableHead>Patient</TableHead>}
                <TableHead className="text-right">Score</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead>Doctor / coordinator told</TableHead>
                <TableHead>Reply</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const redFlag = !!r.doctor_notified_at && !!r.coordinator_notified_at;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{r.created_at.slice(0, 10)}</TableCell>
                    <TableCell>{STAGE[r.stage] ?? r.stage}</TableCell>
                    {showNames && (
                      <TableCell>
                        {r.contact_id ? (nameById.get(r.contact_id) ?? "Linked") : "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right">{r.score ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {redFlag && <Badge variant="destructive">Red flag</Badge>}
                        {r.side_effects_flagged && <Badge variant="warning">Side effect</Badge>}
                        {r.needs_doctor_review && !redFlag && (
                          <Badge variant="outline">Needs a person</Badge>
                        )}
                        {r.score === null && <Badge variant="outline">No score</Badge>}
                        {r.is_test_record && <Badge variant="secondary">Test</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {r.doctor_notified_at ? r.doctor_notified_at.slice(0, 10) : "—"} /{" "}
                      {r.coordinator_notified_at ? r.coordinator_notified_at.slice(0, 10) : "—"}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      {r.reply_text ? (
                        <details>
                          <summary className="text-primary cursor-pointer text-xs">
                            Show reply
                          </summary>
                          <p className="mt-1 text-sm break-words whitespace-pre-wrap">
                            {r.reply_text}
                          </p>
                        </details>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {(count ?? 0) > LIMIT && (
        <p className="text-muted-foreground text-xs">
          Showing the newest {LIMIT} of {count}.
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        A red flag is a score at or below the signed-off threshold or a side-effect word, and always
        alerts both the treating doctor and the care coordinators. While those settings are unsigned
        every reply goes to a person.
      </p>
    </div>
  );
}
