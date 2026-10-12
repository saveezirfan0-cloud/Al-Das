import { describe, expect, it } from "vitest";

import {
  accessLogToCsv,
  alertsToCsv,
  authEventsToCsv,
  changesToCsv,
  exportFileName,
  parseViewFilters,
  viewQuery,
} from "@/lib/security/activity-view";
import { describeAuthEvent } from "@/lib/security/auth-events-view";

describe("parseViewFilters", () => {
  it("defaults to the Changes view over the last 7 days", () => {
    expect(parseViewFilters({})).toEqual({
      view: "changes",
      period: "7d",
      actor: null,
      type: null,
      entity: null,
      action: null,
      page: 1,
    });
  });
  it("accepts known values and drops anything else", () => {
    const actor = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
    const f = parseViewFilters({
      view: "access",
      period: "30d",
      actor,
      entity: "contact",
      action: "export",
      type: "sign_in",
      page: "3",
    });
    expect(f).toMatchObject({
      view: "access",
      period: "30d",
      actor,
      entity: "contact",
      action: "export",
      type: "sign_in",
      page: 3,
    });
    const bad = parseViewFilters({
      view: "x",
      period: "forever",
      actor: "'; drop table",
      entity: "nope",
      action: "nope",
      type: "nope",
      page: "-4",
    });
    expect(bad).toEqual({
      view: "changes",
      period: "7d",
      actor: null,
      type: null,
      entity: null,
      action: null,
      page: 1,
    });
    expect(parseViewFilters({ page: "99999999" }).page).toBe(1);
    expect(parseViewFilters({ view: ["logins", "access"] }).view).toBe("logins");
  });
  it("builds a link query that keeps the filters", () => {
    const f = parseViewFilters({ view: "logins", period: "24h", type: "sign_in_failed" });
    expect(viewQuery(f)).toBe("view=logins&period=24h&type=sign_in_failed");
    expect(viewQuery(f, { page: 2 })).toContain("page=2");
  });
});

describe("csv builders", () => {
  it("writes a header and one line per row, neutralising spreadsheet formulas", () => {
    const csv = accessLogToCsv([
      {
        at: "2026-10-12T09:00:00Z",
        who: '=HYPERLINK("x")',
        entity: "contact",
        entity_id: "abc",
        action: "view",
        sampled: false,
        rows: null,
      },
      {
        at: "2026-10-12T09:01:00Z",
        who: "Amal, Khan",
        entity: "export",
        entity_id: "contacts",
        action: "export",
        sampled: false,
        rows: 120,
      },
    ]);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("When (UTC),Who,What,Record id,Action,Sampled,Rows");
    expect(lines[1]).toContain("'=HYPERLINK");
    expect(lines[2]).toContain('"Amal, Khan"');
    expect(lines[2].endsWith(",120")).toBe(true);
  });
  it("covers the other views and never includes the raw address column name for hashes", () => {
    expect(
      authEventsToCsv([
        {
          at: "t",
          who: "w",
          event_type: "sign_in",
          method: "password",
          ua_family: "Chrome on Windows",
          ip_address: null,
          ip_hash: "abc",
        },
      ]),
    ).toContain("Chrome on Windows");
    expect(
      changesToCsv([
        { at: "t", who: "w", action: "role.updated", entity: "role", entity_id: null },
      ]),
    ).toContain("role.updated");
    expect(
      alertsToCsv([{ at: "t", kind: "bulk_export", summary: "s", acknowledged: true }]),
    ).toContain("yes");
  });
  it("names the file after the view and the day", () => {
    expect(exportFileName("access", new Date("2026-10-12T00:00:00Z"))).toBe(
      "activity-access-2026-10-12.csv",
    );
  });
});

describe("describeAuthEvent", () => {
  it("labels failures in red and password changes as notable", () => {
    expect(describeAuthEvent("sign_in_failed")).toMatchObject({ tone: "destructive" });
    expect(describeAuthEvent("password_changed").tone).toBe("warning");
    expect(describeAuthEvent("sign_in", "magic_link").label).toContain("link");
    expect(describeAuthEvent("something_new").label).toBe("something new");
  });
});
