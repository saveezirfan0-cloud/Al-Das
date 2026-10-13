import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inbox/send", () => ({ queueOutbound: vi.fn(async () => ({ id: "m-1" })) }));

import { queueOutbound } from "@/lib/inbox/send";
import { sendTeamAutoReply } from "@/lib/inbox/routing";
import {
  autoReplyDecision,
  officeHoursFromForm,
  officeHoursToForm,
  parseOfficeHours,
  parseRouteOutcome,
  type RouteOutcome,
} from "@/lib/inbox/routing-rules";

const TEAM = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";

// Monday 2026-10-12 10:00 in Dubai (UTC+4) = 06:00Z; 23:00 Dubai = 19:00Z.
const MON_10_DUBAI = new Date("2026-10-12T06:00:00Z");
const MON_23_DUBAI = new Date("2026-10-12T19:00:00Z");
const WEEKDAYS = officeHoursFromForm({
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "08:00",
  end: "20:00",
  timezone: "Asia/Dubai",
});

function outcome(over: Partial<RouteOutcome> = {}): RouteOutcome {
  return {
    teamId: TEAM,
    userId: null,
    fallback: false,
    teamOnline: true,
    autoReplyText: "Thanks for your message, we will reply soon.",
    officeHours: WEEKDAYS,
    ...over,
  };
}

describe("parseRouteOutcome", () => {
  it("reads the SQL answer and drops anything malformed", () => {
    expect(
      parseRouteOutcome({
        team_id: TEAM,
        user_id: USER,
        fallback: true,
        team_online: true,
        auto_reply_text: "  Hello  ",
        office_hours: {
          timezone: "Asia/Dubai",
          schedule: { mon: [{ start: "08:00", end: "17:00" }] },
        },
      }),
    ).toEqual({
      teamId: TEAM,
      userId: USER,
      fallback: true,
      teamOnline: true,
      autoReplyText: "Hello",
      officeHours: {
        timezone: "Asia/Dubai",
        schedule: { mon: [{ start: "08:00", end: "17:00" }] },
      },
    });
    expect(parseRouteOutcome(null)).toBeNull();
    expect(parseRouteOutcome([1, 2])).toBeNull();
    const odd = parseRouteOutcome({
      team_id: "nope",
      user_id: 5,
      fallback: "yes",
      auto_reply_text: "   ",
      office_hours: { schedule: { mon: "x" } },
    });
    expect(odd).toEqual({
      teamId: null,
      userId: null,
      fallback: false,
      teamOnline: false,
      autoReplyText: null,
      officeHours: null,
    });
  });

  it("caps the auto-reply at 1024 characters", () => {
    expect(
      parseRouteOutcome({ team_id: TEAM, auto_reply_text: "x".repeat(2000) })?.autoReplyText,
    ).toHaveLength(1024);
  });
});

describe("autoReplyDecision", () => {
  const base = { alreadySentAt: null, lastInboundAt: MON_23_DUBAI, now: MON_23_DUBAI };

  it("replies outside office hours", () => {
    expect(autoReplyDecision({ ...base, outcome: outcome() })).toEqual({
      send: true,
      reason: "outside_hours",
      text: "Thanks for your message, we will reply soon.",
    });
  });

  it("replies inside office hours only when nobody in the team is online", () => {
    const inside = { ...base, lastInboundAt: MON_10_DUBAI, now: MON_10_DUBAI };
    expect(autoReplyDecision({ ...inside, outcome: outcome() })).toEqual({
      send: false,
      reason: "staffed",
    });
    expect(autoReplyDecision({ ...inside, outcome: outcome({ teamOnline: false }) })).toMatchObject(
      {
        send: true,
        reason: "nobody_online",
      },
    );
  });

  it("treats no office hours as always open", () => {
    expect(autoReplyDecision({ ...base, outcome: outcome({ officeHours: null }) })).toEqual({
      send: false,
      reason: "staffed",
    });
    expect(
      autoReplyDecision({ ...base, outcome: outcome({ officeHours: null, teamOnline: false }) })
        .send,
    ).toBe(true);
  });

  it("never replies twice, without text, without a team, or outside the 24 h window", () => {
    expect(
      autoReplyDecision({ ...base, alreadySentAt: "2026-10-12T18:00:00Z", outcome: outcome() }),
    ).toEqual({ send: false, reason: "already_sent" });
    expect(autoReplyDecision({ ...base, outcome: outcome({ autoReplyText: null }) })).toEqual({
      send: false,
      reason: "no_text",
    });
    expect(autoReplyDecision({ ...base, outcome: outcome({ teamId: null }) })).toEqual({
      send: false,
      reason: "no_team",
    });
    expect(autoReplyDecision({ ...base, outcome: null })).toEqual({
      send: false,
      reason: "no_team",
    });
    const old = new Date(MON_23_DUBAI.getTime() - 24 * 3600_000);
    expect(autoReplyDecision({ ...base, lastInboundAt: old, outcome: outcome() })).toEqual({
      send: false,
      reason: "window_closed",
    });
    expect(autoReplyDecision({ ...base, lastInboundAt: null, outcome: outcome() })).toEqual({
      send: false,
      reason: "window_closed",
    });
  });
});

describe("office hours form", () => {
  it("round-trips the same hours on the chosen days, and no days means always open", () => {
    expect(WEEKDAYS?.schedule.mon).toEqual([{ start: "08:00", end: "20:00" }]);
    expect(WEEKDAYS?.schedule.sat).toBeUndefined();
    expect(officeHoursToForm(WEEKDAYS)).toEqual({
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "08:00",
      end: "20:00",
    });
    expect(
      officeHoursFromForm({ days: [], start: "08:00", end: "20:00", timezone: "Asia/Dubai" }),
    ).toBeNull();
    expect(officeHoursToForm(null)).toEqual({ days: [], start: "08:00", end: "20:00" });
  });

  it("ignores unknown days and rejects bad times", () => {
    expect(
      officeHoursFromForm({
        days: ["xyz", "sun"],
        start: "09:00",
        end: "13:00",
        timezone: "Asia/Dubai",
      })?.schedule,
    ).toEqual({
      sun: [{ start: "09:00", end: "13:00" }],
    });
    expect(
      officeHoursFromForm({ days: ["mon"], start: "9am", end: "13:00", timezone: "Asia/Dubai" }),
    ).toBeNull();
    expect(parseOfficeHours({ schedule: { mon: [{ start: "25:00", end: "26:00" }] } })).toBeNull();
  });
});

describe("sendTeamAutoReply", () => {
  function fakeAdmin(claimed: boolean) {
    const calls: Array<Record<string, unknown>> = [];
    const chain = {
      update(v: Record<string, unknown>) {
        calls.push({ update: v });
        return chain;
      },
      eq() {
        return chain;
      },
      is() {
        return chain;
      },
      select: async () => ({ data: claimed ? [{ id: CONV }] : [], error: null }),
    };
    return { admin: { from: () => chain } as never, calls };
  }

  it("claims the conversation first and queues the text once", async () => {
    vi.mocked(queueOutbound).mockClear();
    const { admin, calls } = fakeAdmin(true);
    const reason = await sendTeamAutoReply(admin, {
      orgId: ORG,
      conversationId: CONV,
      outcome: outcome(),
      alreadySentAt: null,
      lastInboundAt: MON_23_DUBAI,
      now: MON_23_DUBAI,
    });
    expect(reason).toBe("outside_hours");
    expect(calls).toEqual([{ update: { auto_reply_sent_at: MON_23_DUBAI.toISOString() } }]);
    expect(vi.mocked(queueOutbound)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queueOutbound).mock.calls[0][1]).toMatchObject({
      orgId: ORG,
      conversationId: CONV,
      spec: { type: "text", body: "Thanks for your message, we will reply soon." },
      sentByUserId: null,
    });
  });

  it("does not queue when another delivery already claimed it", async () => {
    vi.mocked(queueOutbound).mockClear();
    const { admin } = fakeAdmin(false);
    const reason = await sendTeamAutoReply(admin, {
      orgId: ORG,
      conversationId: CONV,
      outcome: outcome(),
      alreadySentAt: null,
      lastInboundAt: MON_23_DUBAI,
      now: MON_23_DUBAI,
    });
    expect(reason).toBe("already_sent");
    expect(vi.mocked(queueOutbound)).not.toHaveBeenCalled();
  });

  it("does not touch the database when the rules say no", async () => {
    vi.mocked(queueOutbound).mockClear();
    const { admin, calls } = fakeAdmin(true);
    const reason = await sendTeamAutoReply(admin, {
      orgId: ORG,
      conversationId: CONV,
      outcome: outcome({ officeHours: null }),
      alreadySentAt: null,
      lastInboundAt: MON_23_DUBAI,
      now: MON_23_DUBAI,
    });
    expect(reason).toBe("staffed");
    expect(calls).toEqual([]);
    expect(vi.mocked(queueOutbound)).not.toHaveBeenCalled();
  });
});
