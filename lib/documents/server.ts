import "server-only";

import { CATEGORY_KEYS } from "@/lib/documents/categories";
import { classifyRetention, type RetentionPolicy } from "@/lib/documents/retention";
import { DOCUMENT_BUCKET } from "@/lib/media/paths";
import { removeObjects } from "@/lib/media/probe";
import type { AdminClient } from "@/lib/supabase/admin";

export type RetentionRow = {
  category: string;
  retain_days: number | null;
  auto_delete: boolean;
};

/** The five categories, each with its policy (keep for ever / no auto-delete when none is set). */
export async function loadRetentionPolicies(
  admin: AdminClient,
  orgId: string,
): Promise<RetentionPolicy[]> {
  const { data } = await admin
    .from("document_retention_policies")
    .select("category, retain_days, auto_delete")
    .eq("org_id", orgId);
  const byCat = new Map((data ?? []).map((r) => [r.category, r]));
  return CATEGORY_KEYS.map((category) => {
    const r = byCat.get(category);
    return { category, retain_days: r?.retain_days ?? null, auto_delete: r?.auto_delete ?? false };
  });
}

export type PastRetentionDoc = {
  id: string;
  category: string;
  created_at: string;
  expires_on: string | null;
  storage_path: string;
};

/**
 * Documents whose retention period has run out, split into those a policy lets the nightly task delete and those a
 * person must review. Looks only at categories that have a period, oldest first, at most `limit` rows per category.
 */
export async function findPastRetention(
  admin: AdminClient,
  orgId: string,
  policies: readonly RetentionPolicy[],
  today: string,
  limit = 200,
): Promise<{ autoDelete: PastRetentionDoc[]; review: PastRetentionDoc[] }> {
  const out = { autoDelete: [] as PastRetentionDoc[], review: [] as PastRetentionDoc[] };
  for (const p of policies) {
    if (p.retain_days === null) continue;
    // Nothing younger than the period can be due, whatever its expiry date: cut the query there.
    const cutoff = new Date(
      Date.parse(`${today}T00:00:00Z`) - p.retain_days * 86_400_000,
    ).toISOString();
    const { data } = await admin
      .from("patient_documents")
      .select("id, category, created_at, expires_on, storage_path")
      .eq("org_id", orgId)
      .eq("category", p.category)
      .eq("status", "ready")
      .lte("created_at", cutoff)
      .order("created_at")
      .limit(limit);
    const split = classifyRetention(data ?? [], [p], today);
    out.autoDelete.push(...split.autoDelete);
    out.review.push(...split.review);
  }
  return out;
}

/**
 * Deletes documents and their files. Files go first and rows only for files that were removed, so a storage failure
 * leaves the record in place for the next attempt. Returns how many documents were deleted.
 */
export async function deleteDocumentsWithFiles(
  admin: AdminClient,
  orgId: string,
  docs: ReadonlyArray<{ id: string; storage_path: string }>,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < docs.length; i += 50) {
    const batch = docs.slice(i, i + 50);
    const ok = await removeObjects(
      admin,
      DOCUMENT_BUCKET,
      batch.map((d) => d.storage_path),
    );
    if (!ok) continue;
    const { error } = await admin
      .from("patient_documents")
      .delete()
      .eq("org_id", orgId)
      .in(
        "id",
        batch.map((d) => d.id),
      );
    if (!error) deleted += batch.length;
  }
  return deleted;
}

export type StorageUsage = {
  library: Record<string, { files: number; bytes: number }>;
  documents: Record<string, { files: number; bytes: number }>;
  documents_by_month: Array<{ month: string; files: number; bytes: number }>;
  library_unscanned: number;
  library_blocked: number;
  documents_unscanned: number;
  documents_blocked: number;
  pending_uploads: number;
  cards_expiring_30d: number;
  cards_expired: number;
};

export async function loadStorageUsage(admin: AdminClient, orgId: string): Promise<StorageUsage> {
  const { data } = await admin.rpc("storage_usage_summary", { p_org: orgId });
  const d = (
    data && typeof data === "object" && !Array.isArray(data) ? data : {}
  ) as Partial<StorageUsage>;
  return {
    library: d.library ?? {},
    documents: d.documents ?? {},
    documents_by_month: d.documents_by_month ?? [],
    library_unscanned: d.library_unscanned ?? 0,
    library_blocked: d.library_blocked ?? 0,
    documents_unscanned: d.documents_unscanned ?? 0,
    documents_blocked: d.documents_blocked ?? 0,
    pending_uploads: d.pending_uploads ?? 0,
    cards_expiring_30d: d.cards_expiring_30d ?? 0,
    cards_expired: d.cards_expired ?? 0,
  };
}

export function sumBytes(group: Record<string, { files: number; bytes: number }>): {
  files: number;
  bytes: number;
} {
  return Object.values(group).reduce(
    (a, v) => ({ files: a.files + v.files, bytes: a.bytes + v.bytes }),
    { files: 0, bytes: 0 },
  );
}
