/**
 * The first-run checklist's per-device storage key, kept apart from lib/help/first-steps.ts so the browser card does
 * not pull the permission catalogue into its bundle.
 */
export function firstRunStorageKey(key: string): string {
  return `pulse-first-run-dismissed:${key}`;
}
