/**
 * Clinically-governed parameters (clinical_settings), as the rules see them.
 *
 * FAIL CLOSED. A setting is usable only when its row is signed off ('approved' with an approved
 * value). The proposed value is used instead only while the org has itself signed off
 * `allow_unsigned_defaults` (internal validation). Anything else is `undefined`, and a rule that needs
 * an undefined setting does not fire. Nothing in lib/clinical hard-codes a threshold.
 */
export type SignOffStatus = "blocking" | "awaiting" | "confirm_exclusion" | "approved";

export type SettingRow = {
  key: string;
  approved_value: string | null;
  proposed_value: string | null;
  sign_off_status: SignOffStatus;
};

const TRUE = new Set(["true", "yes", "1"]);
const FALSE = new Set(["false", "no", "0"]);

export class ClinicalSettings {
  private readonly rows = new Map<string, SettingRow>();
  /** Proposed values may stand in for unsigned ones (internal validation only). */
  readonly allowUnsigned: boolean;

  constructor(rows: Iterable<SettingRow>) {
    for (const r of rows) this.rows.set(r.key, r);
    const a = this.rows.get("allow_unsigned_defaults");
    this.allowUnsigned =
      !!a &&
      a.sign_off_status === "approved" &&
      TRUE.has((a.approved_value ?? "").trim().toLowerCase());
  }

  /** The text a rule may use, or undefined when it must not fire. */
  value(key: string): string | undefined {
    const r = this.rows.get(key);
    if (!r) return undefined;
    const approved = r.sign_off_status === "approved" ? r.approved_value : null;
    const chosen = approved ?? (this.allowUnsigned ? r.proposed_value : null);
    const text = (chosen ?? "").trim();
    return text === "" ? undefined : text;
  }

  num(key: string): number | undefined {
    const v = this.value(key);
    if (v === undefined || !/^-?\d+(\.\d+)?$/.test(v)) return undefined;
    return Number(v);
  }

  bool(key: string): boolean | undefined {
    const v = this.value(key)?.toLowerCase();
    if (v === undefined) return undefined;
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
    return undefined;
  }

  /** A JSON array of strings (trimmed, lower-cased, blanks dropped), or undefined. */
  list(key: string): string[] | undefined {
    const v = this.value(key);
    if (v === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(v);
      if (!Array.isArray(parsed)) return undefined;
      return parsed
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    } catch {
      return undefined;
    }
  }

  isApproved(key: string): boolean {
    const r = this.rows.get(key);
    return !!r && r.sign_off_status === "approved" && r.approved_value !== null;
  }

  /**
   * The patient-facing gate. True only for a signed-off row set to true. `allow_unsigned_defaults`
   * and proposed values are never consulted (mirrors app.clinical_messaging_enabled in SQL).
   */
  messagingEnabled(): boolean {
    const r = this.rows.get("clinical_messaging_enabled");
    return (
      !!r &&
      r.sign_off_status === "approved" &&
      TRUE.has((r.approved_value ?? "").trim().toLowerCase())
    );
  }

  /** The values behind a decision, stored with the evaluation so it can be reproduced. */
  snapshot(keys: Iterable<string>): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = this.value(k) ?? null;
    return out;
  }
}

/** Collects the keys a rule needed but could not get. */
export class Needs {
  readonly missing = new Set<string>();
  readonly used = new Set<string>();
  constructor(private readonly s: ClinicalSettings) {}

  num(key: string): number | undefined {
    this.used.add(key);
    const v = this.s.num(key);
    if (v === undefined) this.missing.add(key);
    return v;
  }
  list(key: string): string[] | undefined {
    this.used.add(key);
    const v = this.s.list(key);
    if (v === undefined) this.missing.add(key);
    return v;
  }
}
