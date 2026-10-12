import { z } from "zod";

import { CATEGORY_KEYS } from "@/lib/documents/categories";

/** Title and note limits for a patient document. The title is typed by staff and is health data. */
export const documentMetaSchema = z.object({
  title: z.string().trim().min(1, "Give the document a title.").max(120),
  category: z.enum(CATEGORY_KEYS),
  expires_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
    .nullable()
    .optional(),
});

export type DocumentMeta = z.infer<typeof documentMetaSchema>;

/** Library names and tags. */
export const assetMetaSchema = z.object({
  name: z.string().trim().min(1, "Give the file a name.").max(120),
  folder_id: z.string().uuid().nullable().optional(),
  tags: z
    .array(z.string().trim().toLowerCase().min(1).max(30))
    .max(10)
    .transform((t) => [...new Set(t)]),
});

export type AssetMeta = z.infer<typeof assetMetaSchema>;

/** Splits "a, b ,c" into clean tags. */
export function parseTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, " "))
        .filter((t) => t.length > 0 && t.length <= 30),
    ),
  ].slice(0, 10);
}
