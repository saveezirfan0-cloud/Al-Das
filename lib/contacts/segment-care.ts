import "server-only";

import { clinicalFieldsIn, segmentIdsIn } from "@/lib/campaigns/audience-purpose";
import { filterSchema } from "@/lib/filters/ast";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";

/** What a person was looking at when they put contacts into a static segment. */
export type SegmentFillSource = {
  /** The filter on screen (the Patients grid's own filter). */
  filter?: unknown;
  /** The segment being viewed, when the contacts came from one. */
  segmentId?: string | null;
};

/**
 * Do contacts picked from this source carry health information into a list? True when the filter on screen uses a
 * clinical / care-only field (or points at a care-only segment), or the segment being viewed is care only.
 * The rule cannot see who is clever enough to pick the same people by hand; it covers the grid's own paths, which is
 * how a static segment is filled. Fails closed on a segment that cannot be checked.
 */
export async function fillNeedsCareOnly(
  admin: AdminClient,
  orgId: string,
  registry: FieldRegistry,
  source: SegmentFillSource | undefined,
): Promise<boolean> {
  if (!source) return false;
  const segmentIds = new Set<string>();
  if (typeof source.segmentId === "string" && source.segmentId) segmentIds.add(source.segmentId);
  if (source.filter) {
    const parsed = filterSchema.safeParse(source.filter);
    if (!parsed.success) return true; // a filter we cannot read counts as unknown
    if (clinicalFieldsIn(parsed.data, registry).length > 0) return true;
    for (const id of segmentIdsIn(parsed.data)) segmentIds.add(id);
  }
  for (const id of segmentIds) {
    const { data, error } = await admin.rpc("segment_is_care_only", {
      p_org: orgId,
      p_segment: id,
    });
    if (error || data !== false) return true;
  }
  return false;
}

/** Marks a static segment care only (idempotent). Returns true when it was newly marked. */
export async function markSegmentCareOnly(
  admin: AdminClient,
  args: {
    orgId: string;
    segmentId: string;
    userId: string;
    reason: "manual" | "filled_from_clinical_filter";
  },
): Promise<boolean> {
  const { data: before } = await admin
    .from("segments")
    .select("care_only")
    .eq("org_id", args.orgId)
    .eq("id", args.segmentId)
    .maybeSingle();
  if (!before || before.care_only) return false;
  const { error } = await admin.rpc("segment_set_care_only", {
    p_org: args.orgId,
    p_segment: args.segmentId,
    p_value: true,
    p_user: args.userId,
    p_reason: args.reason,
  });
  if (error) throw new Error("Could not mark the segment as care only.");
  return true;
}

/** Releases a care-only mark. The caller has checked the permission. Returns whether the segment is still care only. */
export async function releaseSegmentCareOnly(
  admin: AdminClient,
  args: { orgId: string; segmentId: string; userId: string },
): Promise<boolean> {
  const { data, error } = await admin.rpc("segment_set_care_only", {
    p_org: args.orgId,
    p_segment: args.segmentId,
    p_value: false,
    p_user: args.userId,
  });
  if (error) throw new Error("Could not release the segment.");
  return data === true;
}
