import { formatInTimeZone } from "date-fns-tz";

import { addDays } from "@/lib/reports/range";
import { formatValue } from "@/lib/reports/format";
import type { DigestSection } from "@/lib/reports/management";

/**
 * Management digest e-mail: scheduling and rendering, pure. The numbers come from the Management
 * dashboard code (lib/reports/management.ts); this file only decides WHEN a digest is due and HOW it reads.
 * The e-mail carries counts and durations only: no names, no phone numbers, no message text.
 */

export type DigestKind = "daily" | "weekly";

/** Local hour (org timezone) at which a digest becomes due, and how long afterwards it may still be sent. */
export const DIGEST_SEND_HOUR = 7;
export const DIGEST_GRACE_HOURS = 4;

export type DigestWindow = {
  kind: DigestKind;
  /** Unique per org-local period, so a retried tick sends nothing twice. */
  periodKey: string;
  /** The reporting period, inclusive org-local days. */
  fromDay: string;
  toDay: string;
  label: string;
};

function isoWeek(ymd: string): { year: number; week: number } {
  // ISO-8601 week of a calendar date (Thursday rule).
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return { year: d.getUTCFullYear(), week };
}

/** Is a digest of this kind due right now for an org in `timezone`? */
export function digestDue(kind: DigestKind, now: Date, timezone: string): boolean {
  let hour: number;
  let weekday: number; // ISO: Monday = 1
  try {
    hour = Number(formatInTimeZone(now, timezone, "H"));
    weekday = Number(formatInTimeZone(now, timezone, "i"));
  } catch {
    return false;
  }
  if (hour < DIGEST_SEND_HOUR || hour >= DIGEST_SEND_HOUR + DIGEST_GRACE_HOURS) return false;
  return kind === "daily" || weekday === 1;
}

/** The period a digest sent `now` reports on: yesterday, or the previous Monday-to-Sunday week. */
export function digestWindow(kind: DigestKind, now: Date, timezone: string): DigestWindow {
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  if (kind === "daily") {
    const day = addDays(today, -1);
    return { kind, periodKey: day, fromDay: day, toDay: day, label: day };
  }
  const weekday = Number(formatInTimeZone(now, timezone, "i")); // Monday = 1
  const thisMonday = addDays(today, -(weekday - 1));
  const fromDay = addDays(thisMonday, -7);
  const toDay = addDays(thisMonday, -1);
  const { year, week } = isoWeek(fromDay);
  return {
    kind,
    periodKey: `${year}-W${String(week).padStart(2, "0")}`,
    fromDay,
    toDay,
    label: `${fromDay} to ${toDay}`,
  };
}

export type RenderedDigest = { subject: string; text: string; html: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderDigest(input: {
  orgName: string;
  window: DigestWindow;
  sections: DigestSection[];
  dashboardUrl: string;
}): RenderedDigest {
  const { orgName, window: w, sections, dashboardUrl } = input;
  const heading = w.kind === "daily" ? "Daily digest" : "Weekly digest";
  const subject = `[${orgName}] ${heading}: ${w.label}`;
  const textLines: string[] = [`${heading} for ${orgName}`, `Period: ${w.label}`, ""];
  const htmlParts: string[] = [
    `<h2 style="margin:0 0 4px">${esc(heading)}</h2>`,
    `<p style="margin:0 0 16px;color:#555">${esc(orgName)} &middot; ${esc(w.label)}</p>`,
  ];
  if (sections.length === 0) {
    textLines.push("No dashboard data is available yet for this period.");
    htmlParts.push("<p>No dashboard data is available yet for this period.</p>");
  }
  for (const s of sections) {
    textLines.push(s.title.toUpperCase());
    htmlParts.push(
      `<h3 style="margin:16px 0 6px">${esc(s.title)}</h3><table style="border-collapse:collapse">`,
    );
    for (const k of s.kpis) {
      const value = formatValue(k.value, k.format);
      textLines.push(`  ${k.label}: ${value}${k.hint ? ` (${k.hint})` : ""}`);
      htmlParts.push(
        `<tr><td style="padding:2px 16px 2px 0;color:#555">${esc(k.label)}</td><td style="padding:2px 0;font-weight:600">${esc(value)}</td></tr>`,
      );
    }
    htmlParts.push("</table>");
    textLines.push("");
  }
  textLines.push(
    `Open the dashboard: ${dashboardUrl}`,
    "",
    "You receive this because you turned on the digest in Settings > Notifications.",
  );
  htmlParts.push(
    `<p style="margin-top:20px"><a href="${esc(dashboardUrl)}">Open the Management dashboard</a></p>`,
    `<p style="color:#777;font-size:12px">You receive this because you turned on the digest in Settings &rsaquo; Notifications.</p>`,
  );
  return {
    subject,
    text: textLines.join("\n"),
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px">${htmlParts.join("")}</div>`,
  };
}
