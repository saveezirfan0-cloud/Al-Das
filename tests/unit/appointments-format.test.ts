import { describe, expect, it } from "vitest";

import { dayLabel } from "@/app/(app)/appointments/format";

describe("dayLabel", () => {
  it("uses one fixed pattern so the server and the browser render the same text", () => {
    expect(dayLabel("2026-10-14")).toBe("Wednesday 14 October 2026");
    expect(dayLabel("2027-01-01")).toBe("Friday 1 January 2027");
  });
  it("keeps the year last so the agenda can drop it", () => {
    expect(dayLabel("2026-10-14").replace(/ \d{4}$/, "")).toBe("Wednesday 14 October");
  });
});
