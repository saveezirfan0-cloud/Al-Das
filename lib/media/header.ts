/**
 * Template header media from the library (pure; unit-tested).
 *
 * A template or a campaign can say "the header media is library file X" by mapping `header.media` to
 * `media:<asset id>`. Nothing is resolved until the message is sent: the outbound job swaps the reference for
 * a fresh signed URL at that moment, so a link never expires while a campaign is still draining.
 * Carousel cards (Phase 20d) have one header each: `card.0.header.media`, `card.1.header.media`, …
 */
import { parseMediaSource } from "@/lib/media/paths";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";
import type { MediaKind } from "@/lib/media/limits";

export const HEADER_MEDIA_KEY = "header.media";

/** The header media kind a template needs (image, video or document), or null for a text-only template. */
export function headerMediaKind(components: MetaTemplateComponent[]): MediaKind | null {
  const v = templateVariables(components).find((x) => x.key === HEADER_MEDIA_KEY);
  return v && (v.kind === "image" || v.kind === "video" || v.kind === "document") ? v.kind : null;
}

/** Every header-media slot of a template (the message header and each carousel card), with its kind. */
export function headerMediaSlots(
  components: MetaTemplateComponent[],
): Array<{ key: string; kind: MediaKind }> {
  const out: Array<{ key: string; kind: MediaKind }> = [];
  for (const v of templateVariables(components))
    if (
      v.component === "header" &&
      (v.kind === "image" || v.kind === "video" || v.kind === "document")
    )
      out.push({ key: v.key, kind: v.kind });
  return out;
}

/** The library asset a values/mapping object points the header at, if any. */
export function headerAssetId(
  ...maps: Array<Record<string, string> | null | undefined>
): string | null {
  for (const m of maps) {
    const id = parseMediaSource(m?.[HEADER_MEDIA_KEY]);
    if (id) return id;
  }
  return null;
}

/** The library asset mapped to one header slot (first map that has one wins). */
export function slotAssetId(
  key: string,
  ...maps: Array<Record<string, string> | null | undefined>
): string | null {
  for (const m of maps) {
    const id = parseMediaSource(m?.[key]);
    if (id) return id;
  }
  return null;
}

/** Every library asset referenced anywhere in a mapping (used when checking a campaign before it starts). */
export function referencedAssetIds(
  ...maps: Array<Record<string, string> | null | undefined>
): string[] {
  const ids = new Set<string>();
  for (const m of maps)
    for (const value of Object.values(m ?? {})) {
      const id = parseMediaSource(value);
      if (id) ids.add(id);
    }
  return [...ids];
}
