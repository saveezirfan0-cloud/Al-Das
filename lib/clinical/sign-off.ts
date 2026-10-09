/** Validates and normalises a value being signed off, per the setting's value type. Pure. */
export type ValueType = "text" | "number" | "boolean" | "json" | "list";

/** Settings whose sign-off changes what reaches patients or lets proposed values stand in. */
export const GUARDED_KEYS = ["clinical_messaging_enabled", "allow_unsigned_defaults"] as const;
export const CONFIRM_PHRASE = "I CONFIRM";

export function isGuardedKey(key: string): boolean {
  return (GUARDED_KEYS as readonly string[]).includes(key);
}

export function normaliseApprovedValue(
  type: ValueType,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "A value is required." };
  switch (type) {
    case "number":
      return /^-?\d+(\.\d+)?$/.test(text)
        ? { ok: true, value: text }
        : { ok: false, error: "Enter a number." };
    case "boolean": {
      const t = text.toLowerCase();
      if (t === "true" || t === "false") return { ok: true, value: t };
      return { ok: false, error: "Choose true or false." };
    }
    case "list": {
      // One term per line or a JSON array; stored as a JSON array of strings.
      let items: unknown;
      if (text.startsWith("[")) {
        try {
          items = JSON.parse(text);
        } catch {
          return { ok: false, error: "That is not a valid list." };
        }
      } else items = text.split(/\r?\n|,/).map((s) => s.trim());
      if (!Array.isArray(items) || !items.every((x) => typeof x === "string"))
        return { ok: false, error: "A list must contain text items only." };
      const clean = (items as string[]).map((s) => s.trim()).filter(Boolean);
      return clean.length
        ? { ok: true, value: JSON.stringify(clean) }
        : { ok: false, error: "Add at least one term." };
    }
    case "json":
      try {
        JSON.parse(text);
        return { ok: true, value: text };
      } catch {
        return { ok: false, error: "That is not valid JSON." };
      }
    default:
      return { ok: true, value: text };
  }
}
