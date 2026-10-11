import { z } from "zod";

/** Opaque keyset cursor for lists ordered by (created_at desc, id desc). */

const cursorSchema = z.object({ t: z.string().datetime({ offset: true }), id: z.string().uuid() });
export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
