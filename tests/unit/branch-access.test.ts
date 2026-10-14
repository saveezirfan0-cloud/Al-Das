import { describe, expect, it } from "vitest";

import {
  ALL_BRANCHES,
  allowedLocations,
  branchFilterIds,
  branchOrFilter,
  canSeeLocation,
  chooseBranch,
  readBranchAccess,
} from "@/lib/branches/access";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const ALL = [A, B, C];

const everyone = readBranchAccess({});
const twoBranches = readBranchAccess({
  branchScope: "selected",
  branchIds: [A, C],
  homeLocationId: C,
});
const oneBranch = readBranchAccess({ branchScope: "selected", branchIds: [B] });

describe("branch access", () => {
  it("defaults to every branch", () => {
    expect(everyone).toEqual({ scope: "all", ids: [], home: null });
    expect(ALL.every((id) => canSeeLocation(everyone, id))).toBe(true);
  });

  it("limits a selected member to their branches, but rows without a branch stay visible", () => {
    expect(canSeeLocation(twoBranches, A)).toBe(true);
    expect(canSeeLocation(twoBranches, B)).toBe(false);
    expect(canSeeLocation(twoBranches, null)).toBe(true);
    expect(
      allowedLocations(
        ALL.map((id) => ({ id })),
        twoBranches,
      ).map((l) => l.id),
    ).toEqual([A, C]);
  });

  it("opens on the switcher's choice when allowed, else home, else the only branch", () => {
    expect(chooseBranch(A, twoBranches, ALL)).toBe(A);
    expect(chooseBranch(B, twoBranches, ALL)).toBe(C); // not allowed: falls back to home
    expect(chooseBranch(undefined, twoBranches, ALL)).toBe(C);
    expect(chooseBranch(ALL_BRANCHES, twoBranches, ALL)).toBeNull();
    expect(chooseBranch(undefined, oneBranch, ALL)).toBe(B);
    expect(chooseBranch(ALL_BRANCHES, oneBranch, ALL)).toBe(B);
    expect(chooseBranch(undefined, everyone, ALL)).toBeNull();
  });

  it("builds the service-role filter and never widens access", () => {
    expect(branchFilterIds(everyone, null)).toBeNull();
    expect(branchFilterIds(everyone, B)).toEqual([B]);
    expect(branchFilterIds(twoBranches, null)).toEqual([A, C]);
    expect(branchFilterIds(twoBranches, B)).toEqual([]);
    expect(branchOrFilter([A])).toBe(`location_id.in.(${A}),location_id.is.null`);
    expect(branchOrFilter([])).toBe("location_id.is.null");
    expect(branchOrFilter(["x),org_id.eq.(y"])).toBe("location_id.is.null");
  });
});
