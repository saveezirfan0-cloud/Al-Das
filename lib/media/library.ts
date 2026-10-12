import "server-only";

import { LIBRARY_BUCKET } from "@/lib/media/paths";
import type { AdminClient } from "@/lib/supabase/admin";

export type LibraryAsset = {
  id: string;
  name: string;
  kind: "image" | "video" | "document";
  mime_type: string;
  size_bytes: number;
  original_size_bytes: number | null;
  width: number | null;
  height: number | null;
  tags: string[];
  folder_id: string | null;
  scan_status: string;
  created_at: string;
  uploader: string | null;
  /** Signed thumbnail link (10 minutes), images only. */
  thumb_url: string | null;
};

export type LibraryQuery = {
  folder?: string | "none" | null;
  kind?: "image" | "video" | "document" | null;
  tag?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
  /** Only files Meta accepts for this header kind (used by the template builder picker). */
  mimes?: readonly string[] | null;
};

const COLUMNS =
  "id, name, kind, mime_type, size_bytes, original_size_bytes, width, height, tags, folder_id, scan_status, created_at, storage_path, thumb_path, uploaded_by";

/** Characters that would change a PostgREST filter (or are LIKE wildcards) are dropped from search text. */
export function cleanSearch(q: string | null | undefined): string {
  return (q ?? "")
    .replace(/[%_\\,()"{}*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export async function listLibraryAssets(
  admin: AdminClient,
  orgId: string,
  query: LibraryQuery = {},
): Promise<{ assets: LibraryAsset[]; total: number }> {
  let sel = admin
    .from("media_assets")
    .select(COLUMNS, { count: "exact" })
    .eq("org_id", orgId)
    .eq("status", "ready");
  if (query.folder === "none") sel = sel.is("folder_id", null);
  else if (query.folder) sel = sel.eq("folder_id", query.folder);
  if (query.kind) sel = sel.eq("kind", query.kind);
  if (query.mimes?.length) sel = sel.in("mime_type", [...query.mimes]);
  const tag = cleanSearch(query.tag).toLowerCase();
  if (tag) sel = sel.contains("tags", [tag]);
  const q = cleanSearch(query.q);
  if (q) sel = sel.or(`name.ilike.%${q}%,tags.cs.{"${q.toLowerCase()}"}`);
  const limit = Math.min(Math.max(query.limit ?? 48, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const { data, count } = await sel
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  const rows = data ?? [];

  const thumbPaths = rows
    .filter((r) => r.kind === "image")
    .map((r) => r.thumb_path ?? r.storage_path);
  const signed = new Map<string, string>();
  if (thumbPaths.length) {
    const { data: urls } = await admin.storage
      .from(LIBRARY_BUCKET)
      .createSignedUrls(thumbPaths, 600);
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
  }
  const uploaderIds = [...new Set(rows.map((r) => r.uploaded_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (uploaderIds.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", uploaderIds);
    for (const p of profiles ?? [])
      names.set(p.id, `${p.first_name} ${p.last_name}`.trim() || "Someone");
  }
  return {
    total: count ?? rows.length,
    assets: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as LibraryAsset["kind"],
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      original_size_bytes: r.original_size_bytes,
      width: r.width,
      height: r.height,
      tags: r.tags,
      folder_id: r.folder_id,
      scan_status: r.scan_status,
      created_at: r.created_at,
      uploader: r.uploaded_by ? (names.get(r.uploaded_by) ?? null) : null,
      thumb_url: r.kind === "image" ? (signed.get(r.thumb_path ?? r.storage_path) ?? null) : null,
    })),
  };
}

export type AssetUsage = {
  kind: "template" | "campaign" | "quick_reply";
  ref_id: string;
  ref_name: string;
  ref_status: string | null;
  blocking: boolean;
};

export async function assetUsage(
  admin: AdminClient,
  orgId: string,
  assetId: string,
): Promise<AssetUsage[]> {
  const { data } = await admin.rpc("media_asset_usage", { p_org: orgId, p_asset: assetId });
  return (data ?? []) as AssetUsage[];
}

/** One line for a message that explains why a file cannot be deleted. */
export function usageSummary(usage: readonly AssetUsage[]): string {
  const live = usage.filter((u) => u.blocking);
  const word = { template: "template", campaign: "campaign", quick_reply: "quick reply" } as const;
  const parts = live.slice(0, 3).map((u) => `${word[u.kind]} "${u.ref_name}"`);
  const more = live.length > 3 ? ` and ${live.length - 3} more` : "";
  return `Used by ${parts.join(", ")}${more}.`;
}
