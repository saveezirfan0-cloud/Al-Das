import { z } from "zod";

import { TEMPLATE_CATEGORIES, type TemplateDraft } from "@/lib/whatsapp/template-draft";

const button = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().max(100) }),
  z.object({
    type: z.literal("URL"),
    text: z.string().max(100),
    url: z.string().max(2100),
    example: z.string().max(2100).optional(),
  }),
  z.object({
    type: z.literal("PHONE_NUMBER"),
    text: z.string().max(100),
    phone_number: z.string().max(40),
  }),
  z.object({ type: z.literal("COPY_CODE"), example: z.string().max(40) }),
]);

const mediaHeader = z.object({
  format: z.enum(["IMAGE", "VIDEO", "DOCUMENT"]),
  handle: z.string().max(500).optional(),
  samplePath: z.string().max(300).optional(),
});

const header = z.union([
  z.object({ format: z.literal("NONE") }),
  z.object({
    format: z.literal("TEXT"),
    text: z.string().max(300),
    example: z.string().max(1100).optional(),
  }),
  mediaHeader,
  z.object({ format: z.literal("LOCATION") }),
]);

/** Shape check for what the browser sends; Meta's content rules live in `validateDraft`. */
export const templateDraftSchema = z.object({
  name: z.string().max(600),
  language: z.string().max(10),
  category: z.enum(TEMPLATE_CATEGORIES),
  kind: z.enum(["standard", "media_interactive", "carousel"]),
  header,
  body: z.string().max(5000),
  bodyExamples: z.array(z.string().max(1100)).max(30),
  footer: z.string().max(300),
  buttons: z.array(button).max(12),
  cards: z
    .array(
      z.object({
        header: z.object({
          format: z.enum(["IMAGE", "VIDEO"]),
          handle: z.string().max(500).optional(),
          samplePath: z.string().max(300).optional(),
        }),
        body: z.string().max(1000),
        bodyExamples: z.array(z.string().max(1100)).max(10),
        buttons: z.array(button).max(4),
      }),
    )
    .max(12),
  variableMap: z.record(z.string().max(40), z.string().max(60)),
}) satisfies z.ZodType<TemplateDraft>;
