/**
 * Which reads are written to record_access_log.
 *
 *  - view / download / export of ONE record or file: always.
 *  - list / search screens: sampled (settings.list_sample_rate), because a grid refresh would otherwise
 *    swamp the log. A sampled row says "this person looked at a list of N records at this time".
 */

/**
 * A page that re-renders itself (the inbox refreshes on every realtime event) must not write a new
 * "opened" row each time: the same person opening the same record again within this many minutes is one
 * open. Downloads and exports are never merged.
 */
export const VIEW_DEDUPE_MINUTES = 5;

export type AccessAction = "view" | "list" | "search" | "download" | "export";

const ALWAYS: ReadonlySet<AccessAction> = new Set(["view", "download", "export"]);

export function shouldLogAccess(
  action: AccessAction,
  sampleRate: number,
  random: () => number = Math.random,
): boolean {
  if (ALWAYS.has(action)) return true;
  if (!(sampleRate > 0)) return false;
  if (sampleRate >= 1) return true;
  return random() < sampleRate;
}
