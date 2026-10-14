import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PORTAL_SECTIONS } from "@/app/(app)/portal/sections";
import { NAV_ITEMS } from "@/components/shell/nav";
import { NAV_MODULES } from "@/lib/nav/modules";

// A page's menu label, its heading and its browser title say the same thing, so people find in the menu what they
// see on the page and in the tab. Compared only where all are plain strings in the source; a tab-group entry (its
// label names the group, Phase D) is skipped. Deliberate differences are listed below, each with its reason.

const DIFFERENT_ON_PURPOSE: Readonly<Record<string, string>> = {
  "/recall": "the heading names the programmes; Recall is the menu word",
  "/settings/appointments?tab=locations":
    "CRM, Branches opens the Branches tab of Clinic and appointments (the page's own name)",
  "/dashboard/management": "short menu word in Insights; the page is the Management dashboard",
  "/finance/cashup": "the heading adds End-of-day for people new to the word",
  "/accounting/statements": "short within Accounting, Receivables; the page is Customer statements",
  "/accounting/reports/vat-return": "the heading adds the form number (VAT 201)",
  "/accounting/reports/exceptions":
    "the menu says Ledger exceptions to tell it apart from Finance exceptions",
  "/settings/notifications": "the title adds settings to tell it apart from the notification list",
  "/settings/channels": "the menu names the WhatsApp channels; the page also holds web and social",
  "/settings/inbox": "menu says Inbox rules so it is not mistaken for the Inbox",
  "/settings/unite": "the title adds settings; the menu and heading say Unite EMR",
  "/settings/front-desk": "the title adds settings to tell it apart from the Front desk page",
  "/settings/enquiries": "menu says Enquiry pipelines so it is not mistaken for the Enquiries page",
};

const APP = path.join(process.cwd(), "app", "(app)");

/** The plain-string browser title and PageHeader heading of a page, when the source has them. */
function pageTexts(href: string): { title?: string; heading?: string } {
  const file = path.join(APP, href.split(/[?#]/)[0], "page.tsx");
  if (!existsSync(file)) return {};
  const src = readFileSync(file, "utf8");
  const title = src.match(/export const metadata[^=]*=\s*\{\s*title:\s*"([^"]*)"/)?.[1];
  const header = src.match(/<PageHeader\b[^>]*?\btitle=(?:"([^"]*)"|\{"([^"]*)"\})/);
  return { title, heading: header?.[1] ?? header?.[2] };
}

type Entry = { href: string; label: string };
const ENTRIES: Entry[] = [
  ...NAV_ITEMS,
  ...Object.values(NAV_MODULES)
    .flat()
    .filter((e) => !e.tabs),
  ...PORTAL_SECTIONS,
].map(({ href, label }) => ({ href, label }));

function mismatch(e: Entry): string | null {
  const { title, heading } = pageTexts(e.href);
  const says = [title, heading].filter((x): x is string => x !== undefined);
  return says.some((x) => x !== e.label)
    ? `${e.href}: menu "${e.label}", title "${title ?? "-"}", heading "${heading ?? "-"}"`
    : null;
}

describe("menu labels match page titles", () => {
  it("compares a useful number of pages", () => {
    const compared = ENTRIES.filter((e) => pageTexts(e.href).title !== undefined);
    expect(compared.length).toBeGreaterThan(60);
  });

  it("every menu label equals the page's title and heading, unless listed as deliberate", () => {
    const wrong = ENTRIES.filter((e) => !(e.href in DIFFERENT_ON_PURPOSE))
      .map(mismatch)
      .filter(Boolean);
    expect(wrong).toEqual([]);
  });

  it("lists only real, still-different pages as deliberate", () => {
    const stale = Object.keys(DIFFERENT_ON_PURPOSE).filter((href) => {
      const e = ENTRIES.find((x) => x.href === href);
      return !e || mismatch(e) === null;
    });
    expect(stale).toEqual([]);
  });

  it("uses the agreed names for the pages the navigation review renamed", () => {
    const label = (href: string) => ENTRIES.find((e) => e.href === href)?.label;
    expect(label("/settings/appointments")).toBe("Clinic and appointments");
    expect(pageTexts("/settings/appointments")).toEqual({
      title: "Clinic and appointments",
      heading: "Clinic and appointments",
    });
    expect(label("/accounting/dashboard")).toBe("Accounting overview");
    expect(pageTexts("/accounting/dashboard")).toEqual({
      title: "Accounting overview",
      heading: "Accounting overview",
    });
    expect(label("/portal/sync-review")).toBe("Sync review");
    expect(pageTexts("/portal/sync-review")).toEqual({
      title: "Sync review",
      heading: "Sync review",
    });
  });
});
