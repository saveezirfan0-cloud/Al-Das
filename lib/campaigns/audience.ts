import "server-only";

import {
  audiencePurposeProblem,
  DEFAULT_AUDIENCE_PURPOSE,
  type AudiencePurpose,
} from "@/lib/campaigns/audience-purpose";
import { MAX_RECIPIENTS } from "@/lib/campaigns/constants";
import {
  classifyRecipient,
  parseCsvAudience,
  type CsvAudience,
  type SkipReason,
} from "@/lib/campaigns/recipients";
import type { VariableContact } from "@/lib/campaigns/variables";
import {
  compileContactPredicate,
  fetchContactsByIds,
  matchingContactIds,
} from "@/lib/contacts/query";
import { loadCustomFields, registryFor } from "@/lib/contacts/server";
import { filterSchema, type Filter } from "@/lib/filters/ast";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export { audiencePurposeProblem, type AudiencePurpose } from "@/lib/campaigns/audience-purpose";

export type AudienceSample = VariableContact & { csv?: Record<string, string> };

export type AudienceCounts = {
  total: number;
  eligible: number;
  /** New contacts a CSV campaign would create (0 for segments). */
  created: number;
  skipped: Partial<Record<SkipReason, number>>;
  tooMany: boolean;
};

export type CsvPreview = {
  columns: string[];
  rejected: Array<{ line: number; reason: string }>;
  rejectedCount: number;
  duplicates: number;
};

const CSV_CHUNK = 3000;

function counts(raw: unknown, tooMany: boolean): AudienceCounts {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    total: Number(o.total ?? 0),
    eligible: Number(o.eligible ?? 0),
    created: Number(o.created ?? 0),
    skipped: (o.skipped ?? {}) as AudienceCounts["skipped"],
    tooMany,
  };
}

function mergeCounts(a: AudienceCounts, b: AudienceCounts): AudienceCounts {
  const skipped: AudienceCounts["skipped"] = { ...a.skipped };
  for (const [k, v] of Object.entries(b.skipped) as Array<[SkipReason, number]>)
    skipped[k] = (skipped[k] ?? 0) + v;
  return {
    total: a.total + b.total,
    eligible: a.eligible + b.eligible,
    created: a.created + b.created,
    skipped,
    tooMany: a.tooMany || b.tooMany,
  };
}

// ---------------------------------------------------------------------------
// Segment audiences
// ---------------------------------------------------------------------------

async function segmentPredicate(
  admin: AdminClient,
  orgId: string,
  segmentId: string,
  timezone: string,
  purpose: AudiencePurpose,
) {
  const { data: seg } = await admin
    .from("segments")
    .select("id, kind, filter")
    .eq("org_id", orgId)
    .eq("id", segmentId)
    .maybeSingle();
  if (!seg) throw new Error("Segment not found.");
  const registry = registryFor(await loadCustomFields(admin, orgId));
  let filter: Filter | null;
  if (seg.kind === "static") {
    filter = {
      include: {
        type: "group",
        logic: "and",
        children: [{ type: "condition", field: "segments", op: "has_any", value: [seg.id] }],
      },
    };
  } else {
    const parsed = filterSchema.safeParse(seg.filter);
    if (!parsed.success) throw new Error("The segment's filter is invalid.");
    filter = parsed.data;
  }
  // The consent rule (docs/45 P5): a filter with clinical fields, or a segment marked care only, never builds a
  // marketing audience. Checked here, before anything is counted or written, for previews, snapshots and recurring
  // runs alike. The database repeats the check inside campaign_snapshot_segment (same rule, one SQL function).
  let careOnly = false;
  if (purpose !== "care") {
    const { data, error } = await admin.rpc("segment_is_care_only", {
      p_org: orgId,
      p_segment: seg.id,
    });
    if (error) throw new Error("The segment could not be checked for health information.");
    careOnly = data !== false; // fail closed
  }
  const problem = audiencePurposeProblem(filter, purpose, registry, { careOnly });
  if (problem) throw new Error(problem);
  return { registry, filter, ...compileContactPredicate(registry, filter, null, timezone) };
}

export async function segmentAudience(
  admin: AdminClient,
  args: {
    orgId: string;
    segmentId: string;
    marketing: boolean;
    /** What the audience is for. Default "marketing" (fail closed): clinical filters are refused unless "care". */
    purpose?: AudiencePurpose;
    timezone: string;
    /** Writes recipients for this campaign; omit for a dry-run preview. */
    campaignId?: string;
  },
): Promise<{ counts: AudienceCounts; sample: AudienceSample | null }> {
  const purpose = args.purpose ?? DEFAULT_AUDIENCE_PURPOSE;
  const { sql, params, registry, filter } = await segmentPredicate(
    admin,
    args.orgId,
    args.segmentId,
    args.timezone,
    purpose,
  );
  // Always count first: an oversize audience is refused before anything is written.
  const dry = await admin.rpc("campaign_snapshot_segment", {
    p_org_id: args.orgId,
    p_campaign_id: args.campaignId ?? "00000000-0000-0000-0000-000000000000",
    p_where: sql,
    p_params: params as unknown as Json,
    p_marketing: args.marketing,
    p_limit: MAX_RECIPIENTS + 1,
    p_dry: true,
    p_segment_id: args.segmentId,
    p_purpose: purpose,
  });
  if (dry.error) throw new Error(`audience count failed: ${dry.error.message}`);
  let result = counts(dry.data, false);
  result.tooMany = result.total > MAX_RECIPIENTS;

  if (args.campaignId && !result.tooMany) {
    const real = await admin.rpc("campaign_snapshot_segment", {
      p_org_id: args.orgId,
      p_campaign_id: args.campaignId,
      p_where: sql,
      p_params: params as unknown as Json,
      p_marketing: args.marketing,
      p_limit: MAX_RECIPIENTS,
      p_dry: false,
      p_segment_id: args.segmentId,
      p_purpose: purpose,
    });
    if (real.error) throw new Error(`audience snapshot failed: ${real.error.message}`);
    result = { ...counts(real.data, false) };
  }

  // A sample contact so the preview shows real values (first eligible of the first few).
  const ids = await matchingContactIds(
    admin,
    args.orgId,
    registry,
    filter,
    null,
    args.timezone,
    25,
  );
  const rows = await fetchContactsByIds(admin, args.orgId, ids);
  const pick = rows.find((r) => !classifyRecipient(r, { marketing: args.marketing })) ?? null;
  return { counts: result, sample: pick ? { ...pick } : null };
}

// ---------------------------------------------------------------------------
// CSV audiences
// ---------------------------------------------------------------------------

export function parseAudienceCsv(text: string): CsvAudience | { error: string } {
  if (text.length > 12_000_000) return { error: "The file is too large." };
  return parseCsvAudience(text);
}

export function csvPreview(csv: CsvAudience): CsvPreview {
  return {
    columns: csv.columns,
    rejected: csv.rejected.slice(0, 10),
    rejectedCount: csv.rejected.length,
    duplicates: csv.duplicates,
  };
}

export async function csvAudience(
  admin: AdminClient,
  args: {
    orgId: string;
    csv: CsvAudience;
    marketing: boolean;
    confirmedOptIn: boolean;
    userId: string;
    campaignId?: string;
  },
): Promise<{ counts: AudienceCounts; sample: AudienceSample | null }> {
  let total: AudienceCounts = {
    total: 0,
    eligible: 0,
    created: 0,
    skipped: {},
    tooMany: args.csv.tooMany,
  };
  for (let i = 0; i < args.csv.rows.length; i += CSV_CHUNK) {
    const chunk = args.csv.rows.slice(i, i + CSV_CHUNK);
    const { data, error } = await admin.rpc("campaign_add_csv_rows", {
      p_org_id: args.orgId,
      p_campaign_id: args.campaignId ?? "00000000-0000-0000-0000-000000000000",
      p_rows: chunk as unknown as Json,
      p_marketing: args.marketing,
      p_confirmed: args.confirmedOptIn,
      p_user: args.userId,
      p_dry: !args.campaignId,
    });
    if (error) throw new Error(`CSV audience failed: ${error.message}`);
    total = mergeCounts(total, counts(data, false));
  }
  const first = args.csv.rows[0];
  const sample: AudienceSample | null = first
    ? {
        first_name: first.first_name,
        last_name: first.last_name,
        phone_e164: first.phone_e164,
        csv: first.data,
      }
    : null;
  return { counts: total, sample };
}
