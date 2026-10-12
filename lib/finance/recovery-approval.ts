import { createHash } from "node:crypto";

import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * A fingerprint of the WORDING of a template (header text, body, footer and button labels), so that finance's tone approval
 * is bound to what they read: if anyone edits the template afterwards, the approval no longer matches and the reminders stop.
 * Examples and Meta's ids are not part of the wording.
 */
export function templateWordingHash(components: readonly MetaTemplateComponent[]): string {
  const parts: string[] = [];
  for (const c of components as ReadonlyArray<Record<string, unknown>>) {
    const type = String(c.type ?? "");
    if (type === "HEADER" && c.format === "TEXT") parts.push(`H:${String(c.text ?? "")}`);
    else if (type === "BODY") parts.push(`B:${String(c.text ?? "")}`);
    else if (type === "FOOTER") parts.push(`F:${String(c.text ?? "")}`);
    else if (type === "BUTTONS" && Array.isArray(c.buttons))
      for (const b of c.buttons as Array<Record<string, unknown>>)
        parts.push(`U:${String(b.type ?? "")}:${String(b.text ?? "")}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
