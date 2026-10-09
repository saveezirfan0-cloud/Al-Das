import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { formatPhone } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

import { ReviewList, type ReviewItem } from "./review-list";

export const metadata = { title: "Sync Review" };

const STATUSES = ["open", "resolved", "dismissed"] as const;

export default async function SyncReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("portal.sync_review.read");
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(String(sp.status))
    ? (String(sp.status) as (typeof STATUSES)[number])
    : "open";
  const admin = createAdminClient();

  const { data: reviews } = await admin
    .from("sync_reviews")
    .select(
      "id, external_id, entity, reason, candidates, incoming, status, created_at, resolved_at",
    )
    .eq("org_id", member.orgId)
    .eq("source", "unite")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);

  const candidateIds = [
    ...new Set(
      (reviews ?? []).flatMap((r) =>
        Array.isArray(r.candidates)
          ? (r.candidates as Array<{ contact_id?: string }>).map((c) => c.contact_id ?? "")
          : [],
      ),
    ),
  ].filter(Boolean);
  const { data: contacts } = candidateIds.length
    ? await admin
        .from("contacts")
        .select("id, full_name, phone_e164, external_id, dob")
        .eq("org_id", member.orgId)
        .in("id", candidateIds)
    : { data: [] };
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));

  const keys = (reviews ?? []).map((r) => r.external_id);
  const { data: waiting } = keys.length
    ? await admin
        .from("appointments")
        .select("custom")
        .eq("org_id", member.orgId)
        .eq("source", "unite")
        .is("contact_id", null)
        .limit(2000)
    : { data: [] };
  const waitingByKey = new Map<string, number>();
  for (const a of waiting ?? []) {
    const key = (a.custom as Record<string, unknown> | null)?.unite_patient_key;
    if (typeof key === "string") waitingByKey.set(key, (waitingByKey.get(key) ?? 0) + 1);
  }

  const items: ReviewItem[] = (reviews ?? []).map((r) => {
    const inc = (r.incoming ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      key: r.external_id,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
      incoming: {
        pin: typeof inc.pin === "string" ? inc.pin : null,
        name: typeof inc.name === "string" ? inc.name : "",
        phone: typeof inc.phone_e164 === "string" ? formatPhone(inc.phone_e164) : null,
        dob: typeof inc.dob === "string" ? inc.dob : null,
      },
      waitingAppointments: waitingByKey.get(r.external_id) ?? 0,
      candidates: (Array.isArray(r.candidates)
        ? (r.candidates as Array<{ contact_id: string; matched_on: string }>)
        : []
      )
        .map((c) => {
          const contact = byId.get(c.contact_id);
          return contact
            ? {
                id: contact.id,
                name: contact.full_name || "Unnamed",
                phone: contact.phone_e164 ? formatPhone(contact.phone_e164) : null,
                pin: contact.external_id,
                dob: contact.dob,
                matchedOn: c.matched_on,
              }
            : null;
        })
        .filter((c): c is NonNullable<typeof c> => !!c),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sync Review"
        description="Unite patients that could not be matched to a single contact. Nothing is merged automatically."
      />
      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/portal/sync-review?status=${s}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm capitalize",
              s === status ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {s}
          </Link>
        ))}
      </div>
      <ReviewList items={items} canResolve={can(member, "portal.sync_review.write")} />
    </div>
  );
}
