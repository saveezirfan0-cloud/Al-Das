/**
 * Phase B, second slice (docs/34_CLINIC_OS_PLAN.md): finance branch codes on locations, the list branch filter shared by
 * the inbox and tasks, the inbox query's branch parameter and the routing team order. Pure; synthetic ids only.
 */
import { describe, expect, it } from "vitest";

import { readBranchAccess } from "@/lib/branches/access";
import {
  branchCodeOptions,
  branchCodeProblem,
  normalizeBranchCode,
  pickBranchCode,
} from "@/lib/branches/codes";
import { viewBranchIds } from "@/lib/branches/filter";
import {
  DEFAULT_QUERY,
  inboxBranchIds,
  parseInboxQuery,
  queryToViewFilter,
  toSearchParams,
  viewFilterToQuery,
} from "@/lib/inbox/folders";
import { routingTeamId } from "@/lib/inbox/routing-rules";

const NORTH = "11111111-1111-4111-8111-111111111111";
const SOUTH = "22222222-2222-4222-8222-222222222222";
const EAST = "33333333-3333-4333-8333-333333333333";

describe("finance branch codes on locations", () => {
  it("normalises a typed code", () => {
    expect(normalizeBranchCode(" p ")).toBe("P");
    expect(normalizeBranchCode("m2")).toBe("M2");
    expect(normalizeBranchCode("")).toBeNull();
    expect(normalizeBranchCode("   ")).toBeNull();
    expect(normalizeBranchCode(null)).toBeNull();
    expect(normalizeBranchCode(undefined)).toBeNull();
    expect(normalizeBranchCode("PALM1")).toBe("invalid");
    expect(normalizeBranchCode("P-1")).toBe("invalid");
    expect(normalizeBranchCode(5)).toBe("invalid");
  });

  it("refuses a malformed, unknown or taken code and accepts none", () => {
    expect(branchCodeProblem(null, ["P", "M"])).toBeNull();
    expect(branchCodeProblem("invalid", ["P"])).toMatch(/one to four/);
    expect(branchCodeProblem("X", ["P", "M"])).toMatch(/no finance branch with the code X/);
    expect(branchCodeProblem("P", ["P", "M"])).toBeNull();
    expect(branchCodeProblem("P", ["P"], "North clinic")).toMatch(/North clinic already uses/);
    // Before the finance list is set up any well-formed code is accepted.
    expect(branchCodeProblem("Z", [])).toBeNull();
  });

  it("labels finance codes with the clinic that uses them, sorted, plus codes only a location holds", () => {
    const options = branchCodeOptions(
      [
        { code: "P", name: "Palm" },
        { code: "G", name: "Golden" },
        { code: "M", name: "Meadows" },
      ],
      [
        { id: NORTH, name: "North clinic", branch_code: "M" },
        { id: SOUTH, name: "Palm", branch_code: "P" },
        { id: EAST, name: "East clinic", branch_code: "E" },
      ],
    );
    expect(options).toEqual([
      { code: "E", label: "E · East clinic", locationId: EAST },
      { code: "G", label: "G · Golden", locationId: null },
      { code: "M", label: "M · North clinic (Meadows)", locationId: NORTH },
      { code: "P", label: "P · Palm", locationId: SOUTH },
    ]);
  });

  it("accepts only an offered code from a link", () => {
    const options = [{ code: "P" }, { code: "M" }];
    expect(pickBranchCode("p", options)).toBe("P");
    expect(pickBranchCode("X", options)).toBeNull();
    expect(pickBranchCode("", options)).toBeNull();
    expect(pickBranchCode(["P"], options)).toBeNull();
    expect(pickBranchCode("P'; drop", options)).toBeNull();
  });
});

describe("list branch filter (inbox and tasks)", () => {
  const everyone = { access: readBranchAccess({}), filterIds: null };
  const limited = {
    access: readBranchAccess({ branchScope: "selected", branchIds: [NORTH, EAST] }),
    filterIds: [NORTH, EAST],
  };
  const switched = {
    access: readBranchAccess({ branchScope: "selected", branchIds: [NORTH, EAST] }),
    filterIds: [NORTH],
  };

  it("follows the switcher when the list has no choice of its own", () => {
    expect(viewBranchIds(null, everyone)).toBeNull();
    expect(viewBranchIds(null, limited)).toEqual([NORTH, EAST]);
    expect(viewBranchIds(undefined, switched)).toEqual([NORTH]);
  });

  it("'all' means every branch the member may see, never more", () => {
    expect(viewBranchIds("all", everyone)).toBeNull();
    expect(viewBranchIds("all", switched)).toEqual([NORTH, EAST]);
  });

  it("an explicit branch narrows to it, and a hidden one leaves only rows without a branch", () => {
    expect(viewBranchIds(SOUTH, everyone)).toEqual([SOUTH]);
    expect(viewBranchIds(EAST, switched)).toEqual([EAST]);
    expect(viewBranchIds(SOUTH, limited)).toEqual([]);
  });

  it("the inbox uses the same rule", () => {
    expect(inboxBranchIds).toBe(viewBranchIds);
  });
});

describe("inbox query branch parameter", () => {
  it("parses 'all' and branch ids only", () => {
    expect(parseInboxQuery({}).branch).toBeNull();
    expect(DEFAULT_QUERY.branch).toBeNull();
    expect(parseInboxQuery({ branch: "all" }).branch).toBe("all");
    expect(parseInboxQuery({ branch: NORTH.toUpperCase() }).branch).toBe(NORTH);
    expect(parseInboxQuery({ branch: "north" }).branch).toBeNull();
    expect(parseInboxQuery({ branch: `${NORTH},${SOUTH}` }).branch).toBeNull();
  });

  it("round-trips through the link and saved views, and keeps the folder", () => {
    const q = parseInboxQuery({ folder: "mine", branch: NORTH });
    expect(q.folder).toBe("mine");
    expect(toSearchParams(q)).toBe(`?folder=mine&branch=${NORTH}`);
    expect(viewFilterToQuery(queryToViewFilter(q))).toEqual({ ...q, view: null });
  });
});

describe("routing team order", () => {
  it("prefers the number's own team, then the workspace default", () => {
    expect(routingTeamId("team-desk-north", "team-default")).toBe("team-desk-north");
    expect(routingTeamId(null, "team-default")).toBe("team-default");
    expect(routingTeamId(undefined, null)).toBeNull();
    expect(routingTeamId("", "")).toBeNull();
  });
});
