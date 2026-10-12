import "server-only";

import { headerAssetId, headerMediaKind } from "@/lib/media/header";
import { validateMedia, type MediaKind } from "@/lib/media/limits";
import { LIBRARY_BUCKET, isLibraryPathFor } from "@/lib/media/paths";
import { isServable } from "@/lib/media/scan";
import type { AdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/** A library file that cannot be used. The message is safe to show staff (no names, no paths). */
export class MediaUseError extends Error {}

type AssetRow = {
  id: string;
  org_id: string;
  kind: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  status: string;
  scan_status: string;
};

/**
 * Loads a library file and checks it can be used in a template header of this kind: it exists in this org,
 * the upload finished, it was not quarantined, and it satisfies Meta's header rules.
 */
export async function loadUsableAsset(
  admin: AdminClient,
  orgId: string,
  assetId: string,
  expect: MediaKind,
): Promise<AssetRow> {
  const { data } = await admin
    .from("media_assets")
    .select("id, org_id, kind, mime_type, size_bytes, storage_path, status, scan_status")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data || data.status !== "ready")
    throw new MediaUseError("The library file for this header no longer exists.");
  if (!isServable(data.scan_status))
    throw new MediaUseError("The library file was blocked by the malware scan.");
  if (!isLibraryPathFor(data.storage_path, orgId, data.id))
    throw new MediaUseError("The library file has an invalid location.");
  const check = validateMedia(
    { mime: data.mime_type, size: data.size_bytes },
    "template_header",
    expect,
  );
  if (!check.ok) throw new MediaUseError(check.message);
  return data;
}

/**
 * Called by the outbound job just before a template is sent: swaps a `media:<id>` header reference for a signed
 * URL valid for an hour. Values without a library reference are returned untouched.
 */
export async function resolveHeaderMedia(
  admin: AdminClient,
  orgId: string,
  components: MetaTemplateComponent[],
  values: Record<string, string>,
): Promise<Record<string, string>> {
  const assetId = headerAssetId(values);
  if (!assetId) return values;
  const kind = headerMediaKind(components);
  if (!kind) return values; // a text-only template ignores the mapping
  const asset = await loadUsableAsset(admin, orgId, assetId, kind);
  const { data, error } = await admin.storage
    .from(LIBRARY_BUCKET)
    .createSignedUrl(asset.storage_path, 3600);
  if (error || !data?.signedUrl) throw new MediaUseError("The library file could not be reached.");
  return { ...values, "header.media": data.signedUrl };
}

/** Checks every `media:` reference in a campaign or template mapping before anything is sent. Returns an error or null. */
export async function checkMediaReferences(
  admin: AdminClient,
  orgId: string,
  components: MetaTemplateComponent[],
  ...maps: Array<Record<string, string> | null | undefined>
): Promise<string | null> {
  const assetId = headerAssetId(...maps);
  if (!assetId) return null;
  const kind = headerMediaKind(components);
  if (!kind) return null;
  try {
    await loadUsableAsset(admin, orgId, assetId, kind);
    return null;
  } catch (err) {
    return err instanceof MediaUseError ? err.message : "The library file could not be checked.";
  }
}
