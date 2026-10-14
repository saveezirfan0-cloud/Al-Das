import { describe, expect, it } from "vitest";

import { enquiryScopeSql, parseEnquiryScope } from "@/lib/enquiries/scope";
import { ParamBag } from "@/lib/filters/to-sql";

const USER = "22222222-2222-4222-8222-222222222222";

describe("restricted enquiry view (Phase 20c)", () => {
  it("adds no predicate for the default 'all' view or a system caller", () => {
    const bag = new ParamBag();
    expect(enquiryScopeSql({ userId: USER, scope: "all" }, (v) => bag.text(v))).toBeNull();
    expect(enquiryScopeSql(null, (v) => bag.text(v))).toBeNull();
    expect(bag.params).toEqual([]);
  });

  it("calls the one SQL rule with the user id bound as a parameter", () => {
    for (const scope of ["own", "team"] as const) {
      const bag = new ParamBag();
      const sql = enquiryScopeSql({ userId: USER, scope }, (v) => bag.text(v), "e");
      expect(sql).toBe(
        "app.enquiry_visible_to(e.org_id, (($1 ->> 0))::uuid, e.assignee_id, e.created_by)",
      );
      expect(bag.params).toEqual([USER]);
    }
  });

  it("adds the branch rule (Phase B) for a member limited to some branches, alone or with the view", () => {
    const bag = new ParamBag();
    expect(
      enquiryScopeSql({ userId: USER, scope: "all", branchScope: "all" }, (v) => bag.text(v)),
    ).toBeNull();
    expect(
      enquiryScopeSql({ userId: USER, scope: "all", branchScope: "selected" }, (v) => bag.text(v)),
    ).toBe("app.location_visible_to(e.org_id, (($1 ->> 0))::uuid, e.location_id)");
    const both = new ParamBag();
    expect(
      enquiryScopeSql({ userId: USER, scope: "own", branchScope: "selected" }, (v) => both.text(v)),
    ).toBe(
      "app.enquiry_visible_to(e.org_id, (($1 ->> 0))::uuid, e.assignee_id, e.created_by) and " +
        "app.location_visible_to(e.org_id, (($1 ->> 0))::uuid, e.location_id)",
    );
    expect(both.params).toEqual([USER]);
    expect(
      enquiryScopeSql({ userId: "nope", scope: "all", branchScope: "selected" }, () => "x"),
    ).toBe("false");
  });

  it("fails closed on a malformed user id or stored scope", () => {
    expect(enquiryScopeSql({ userId: "x' or true --", scope: "own" }, () => "never")).toBe("false");
    expect(parseEnquiryScope("all")).toBe("all");
    expect(parseEnquiryScope("team")).toBe("team");
    expect(parseEnquiryScope("everything")).toBe("own");
    expect(parseEnquiryScope(null)).toBe("own");
  });
});
