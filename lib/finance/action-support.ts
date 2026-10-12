import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

import { dayNumber } from "@/lib/documents/expiry";

/** Shared pieces for the Phase 18 finance server actions (this file is NOT a "use server" module). */

export type ActionResult<T = undefined> =
  { ok: true; data?: T; message?: string } | { ok: false; error: string };

export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
export const DENIED = "You do not have permission for that.";

export const uuid = z.string().uuid();

/** A calendar date YYYY-MM-DD that exists. */
export const isoDate = z
  .string()
  .trim()
  .refine((v) => dayNumber(v) !== null, "Enter a valid date.");

/** A date field that may be left blank (blank becomes null). */
export const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || dayNumber(v) !== null, "Enter a valid date.");

/** Text that may be left blank (blank becomes null) with a maximum length. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .transform((v) => (v === "" ? null : v));

/** A non-negative amount typed by a person; "1,234.50" is fine, blank is null. */
export const optionalAmount = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v.replace(/,/g, ""))))
  .refine(
    (v) => v === null || (Number.isFinite(v) && v >= 0 && v < 1e12),
    "Enter an amount of zero or more.",
  );

export const optionalInt = (max = 1_000_000) =>
  z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= max),
      "Enter a whole number.",
    );

/** Comma / space / line separated codes -> unique, upper-case, at most `max`. */
export function parseCodeList(raw: string, max = 20): string[] {
  const codes = raw
    .split(/[\s,;]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(codes)].slice(0, max);
}

/** A friendly message for the database errors we expect. Looks at the SQLSTATE only, never at message text. */
export function dbMessage(err: { code?: string } | null | undefined, fallback: string): string {
  switch (err?.code) {
    case "23505":
      return "That already exists.";
    case "23514":
      return fallback;
    case "23503":
      return "That refers to something that no longer exists.";
    case "42501":
      return "That is not allowed (the month may be locked).";
    default:
      return fallback;
  }
}

export function firstIssue(error: z.ZodError, fallback = "Check the form and try again."): string {
  return error.issues[0]?.message ?? fallback;
}

/** A form's FormData as a plain object of strings (files and repeated keys are not used by these forms). */
export function formObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

/** Today's calendar date in the clinic's timezone (the server runs in UTC). */
export function todayIn(timezone: string | null | undefined): string {
  return formatInTimeZone(new Date(), timezone || "UTC", "yyyy-MM-dd");
}
