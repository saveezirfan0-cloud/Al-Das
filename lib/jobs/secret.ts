import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison of the X-Job-Secret header against JOB_SECRET. */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
