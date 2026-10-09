import { describe, expect, it } from "vitest";

import { parseCli } from "../../scripts/load/args";

describe("parseCli", () => {
  it("reads --key value, --key=value and bare flags", () => {
    const { flags, opts } = parseCli([
      "--rate",
      "3000",
      "--org=load-org",
      "--yes-staging",
      "--cleanup",
      "--report",
      "out.md",
    ]);
    expect(opts).toEqual({ rate: "3000", org: "load-org", report: "out.md" });
    expect([...flags].sort()).toEqual(["cleanup", "yes-staging"]);
  });
  it("treats a trailing flag and a flag followed by another flag as booleans", () => {
    const { flags, opts } = parseCli(["--a", "--b", "1", "--c"]);
    expect(opts).toEqual({ b: "1" });
    expect([...flags]).toEqual(["a", "c"]);
  });
});
