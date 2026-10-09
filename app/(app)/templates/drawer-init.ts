import {
  emptyBuilderState,
  fromComponents,
  type BuilderState,
} from "@/lib/whatsapp/template-builder";
import { galleryState, type GalleryTemplate } from "@/lib/whatsapp/template-gallery";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import type { TemplateRow } from "./types";

/** Everything the builder drawer needs to open on a template (or a blank / gallery draft). */
export type DrawerInit = {
  /** Changes whenever the drawer should reset its internal state. */
  key: string;
  id: string | null;
  state: BuilderState;
  channelId: string;
  galleryKey: string | null;
  variableMap: Record<string, string>;
  status: string | null;
  metaId: string | null;
  rejectedReason: string | null;
  submitError: string | null;
  /** Things the clinic still has to provide (gallery placeholders). */
  needs: Array<"media" | "phone" | "link">;
  /** Features of a synced template that the builder cannot round-trip: edit is blocked. */
  unsupported: string[];
};

let counter = 0;
const nextKey = () => `d${++counter}`;

export function blankInit(channelId: string): DrawerInit {
  return {
    key: nextKey(),
    id: null,
    state: emptyBuilderState(),
    channelId,
    galleryKey: null,
    variableMap: {},
    status: null,
    metaId: null,
    rejectedReason: null,
    submitError: null,
    needs: [],
    unsupported: [],
  };
}

export function galleryInit(g: GalleryTemplate, lang: "en" | "ar", channelId: string): DrawerInit {
  return {
    ...blankInit(channelId),
    state: galleryState(g, lang),
    galleryKey: g.key,
    variableMap: { ...g.variableMap },
    needs: g.needs,
  };
}

export function rowInit(row: TemplateRow): DrawerInit {
  const { state, unsupported } = fromComponents(
    {
      name: row.name,
      language: row.language,
      category: row.category,
      parameter_format: row.parameter_format,
    },
    row.components as unknown as MetaTemplateComponent[],
  );
  // Re-attach stored sample files (they are not part of Meta's components).
  const paths = (row.media_paths ?? {}) as Record<string, string>;
  if (state.header.format !== "NONE" && state.header.format !== "TEXT" && paths.header)
    state.header.mediaPath = paths.header;
  state.cards.forEach((c, i) => {
    if (paths[`card.${i}`]) c.mediaPath = paths[`card.${i}`];
  });
  return {
    key: `${row.id}:${row.updated_at}`,
    id: row.id,
    state,
    channelId: row.channel_id ?? "",
    galleryKey: row.gallery_key,
    variableMap: (row.variable_map ?? {}) as Record<string, string>,
    status: row.status,
    metaId: row.meta_template_id,
    rejectedReason: row.rejected_reason,
    submitError: row.submit_error,
    needs: [],
    unsupported,
  };
}
