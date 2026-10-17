import { describe, expect, it } from "vitest";

import { describeChange, statusChangesFrom } from "@/lib/appointments/status-history";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("statusChangesFrom", () => {
  it("lists status and Unite-code changes, newest first, with the words staff see", () => {
    const out = statusChangesFrom([
      {
        id: 1,
        record_id: A,
        at: "2026-10-01T08:00:00Z",
        actor_id: "u1",
        changes: { status: { from: "awaiting", to: "confirmed" } },
      },
      {
        id: 2,
        record_id: A,
        at: "2026-10-02T08:00:00Z",
        actor_id: null,
        changes: {
          status: { from: "confirmed", to: "no_show" },
          external_status: { from: "ACF", to: "NSW" },
        },
      },
      {
        id: 3,
        record_id: B,
        at: "2026-10-03T08:00:00Z",
        actor_id: null,
        changes: { notes: { from: null, to: "x" } },
      },
    ]);
    expect(out.map((c) => [c.appointmentId, c.kind, c.from, c.to, c.byStaff])).toEqual([
      [A, "status", "Confirmed", "No-show", false],
      [A, "unite_code", "ACF", "NSW", false],
      [A, "status", "Awaiting", "Confirmed", true],
    ]);
    expect(out[0]!.at > out[2]!.at).toBe(true);
  });

  it("ignores rows without a status change and malformed changes", () => {
    expect(
      statusChangesFrom([
        { id: 1, record_id: A, at: "2026-10-01T08:00:00Z", actor_id: null, changes: {} },
        { id: 2, record_id: A, at: "2026-10-01T08:00:00Z", actor_id: null, changes: null },
        { id: 3, record_id: A, at: "2026-10-01T08:00:00Z", actor_id: null, changes: [] },
        {
          id: 4,
          record_id: A,
          at: "2026-10-01T08:00:00Z",
          actor_id: null,
          changes: { status: "confirmed" },
        },
      ]),
    ).toEqual([]);
  });

  it("keeps an unmapped status word as it is rather than guessing", () => {
    const [c] = statusChangesFrom([
      {
        id: 1,
        record_id: A,
        at: "2026-10-01T08:00:00Z",
        actor_id: null,
        changes: { status: { from: "awaiting", to: "something_new" } },
      },
    ]);
    expect(c!.to).toBe("something_new");
  });
});

describe("describeChange", () => {
  it("reads naturally", () => {
    expect(describeChange({ kind: "status", from: "Awaiting", to: "Confirmed" })).toBe(
      "Status: Awaiting → Confirmed",
    );
    expect(describeChange({ kind: "unite_code", from: null, to: "ACF" })).toBe(
      "Unite code set to ACF",
    );
    expect(describeChange({ kind: "unite_code", from: "ACF", to: null })).toBe(
      "Unite code ACF cleared",
    );
  });
});
