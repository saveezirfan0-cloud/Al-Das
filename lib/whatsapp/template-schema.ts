/** Zod schema for BuilderState: validates what the browser sends to the template server actions. */
import { z } from "zod";

import { TEMPLATE_CATEGORIES, TEMPLATE_TYPES } from "@/lib/whatsapp/template-builder";

const short = (max: number) => z.string().max(max);

const headerSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("NONE") }),
  z.object({ format: z.literal("TEXT"), text: short(200), example: short(1024) }),
  z.object({
    format: z.enum(["IMAGE", "VIDEO", "DOCUMENT"]),
    handle: short(2000),
    mediaPath: short(300).optional(),
    fileName: short(200).optional(),
  }),
]);

const quickReply = z.object({ type: z.literal("QUICK_REPLY"), text: short(100) });
const urlButton = z.object({
  type: z.literal("URL"),
  text: short(100),
  url: short(2100),
  example: short(2100),
});
const phoneButton = z.object({
  type: z.literal("PHONE_NUMBER"),
  text: short(100),
  phone_number: short(30),
});
const copyCode = z.object({ type: z.literal("COPY_CODE"), example: short(50) });

const buttonSchema = z.discriminatedUnion("type", [quickReply, urlButton, phoneButton, copyCode]);
const cardButtonSchema = z.discriminatedUnion("type", [quickReply, urlButton, phoneButton]);

const cardSchema = z.object({
  format: z.enum(["IMAGE", "VIDEO"]),
  handle: short(2000),
  mediaPath: short(300).optional(),
  body: short(1200),
  examples: z.array(short(1024)).max(10),
  buttons: z.array(cardButtonSchema).max(10),
});

export const builderStateSchema = z.object({
  name: short(600),
  language: short(12),
  category: z.enum(TEMPLATE_CATEGORIES),
  type: z.enum(TEMPLATE_TYPES),
  header: headerSchema,
  body: short(1200),
  examples: z.array(short(1024)).max(20),
  footer: short(200),
  buttons: z.array(buttonSchema).max(20),
  cards: z.array(cardSchema).max(12),
  auth: z.object({
    securityRecommendation: z.boolean(),
    expiryMinutes: z.number().int().nullable(),
    buttonText: short(100),
  }),
});
