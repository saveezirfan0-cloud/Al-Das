/**
 * Phase 20d campaigns: recurring schedule summary, next run, the once-a-day rule, the per-run guardrails and the
 * monthly budget stop. Pure functions only.
 */
import { describe, expect, it } from "vitest";

import {
  applyBudgetGrant,
  budgetMeter,
  readCampaignBudget,
  writeCampaignBudget,
} from "@/lib/campaigns/budget";
import {
  checkRecurrenceSchedule,
  describeCron,
  nextCronRun,
  RECURRENCE_PRESETS,
  recurrenceRunDecision,
  upcomingRuns,
} from "@/lib/campaigns/recurrence";

const DUBAI = "Asia/Dubai";

describe("describeCron", () => {
  it("reads the presets and common schedules in plain words", () => {
    expect(describeCron("0 10 * * *")).toBe("Every day at 10:00");
    expect(describeCron("0 10 * * 1")).toBe("Every Monday at 10:00");
    expect(describeCron("30 9 * * 1-5")).toBe("Every Monday to Friday at 09:30");
    expect(describeCron("0 10 * * 0-4")).toBe("Every Sunday to Thursday at 10:00");
    expect(describeCron("0 10 1 * *")).toBe("On the 1st of every month at 10:00");
    expect(describeCron("0 9,17 15 * *")).toBe("On the 15th of every month at 09:00 and 17:00");
    expect(describeCron("0 8 1 1,7 *")).toBe("On the 1st in January and July at 08:00");
    expect(describeCron("15 * * * *")).toBe("Every day every hour at :15");
    expect(describeCron("0 10 * * 2,4")).toBe("Every Tuesday and Thursday at 10:00");
    expect(describeCron("0 10 * * 7")).toBe("Every Sunday at 10:00");
  });
  it("returns null for anything that is not a 5-field cron", () => {
    for (const bad of ["", "0 10 * *", "61 10 * * *", "every day", "0 10 * * 1 2"])
      expect(describeCron(bad)).toBeNull();
  });
  it("describes every preset", () => {
    for (const p of RECURRENCE_PRESETS) expect(describeCron(p.cron)).toBeTruthy();
  });
});

describe("nextCronRun", () => {
  it("finds the next run in the schedule's timezone (Dubai is UTC+4, no DST)", () => {
    // Monday 26 Oct 2026, 05:00 UTC = 09:00 Dubai. Daily 10:00 Dubai = 06:00 UTC.
    const after = new Date("2026-10-26T05:00:00Z");
    expect(nextCronRun("0 10 * * *", after, DUBAI)?.toISOString()).toBe("2026-10-26T06:00:00.000Z");
    // At exactly the run time, the next one is tomorrow (strictly after).
    expect(nextCronRun("0 10 * * *", new Date("2026-10-26T06:00:00Z"), DUBAI)?.toISOString()).toBe(
      "2026-10-27T06:00:00.000Z",
    );
  });
  it("handles weekdays, month ends and year ends", () => {
    // Friday 30 Oct 2026 12:00 Dubai → next Monday-to-Friday 09:30 is Monday 2 Nov.
    expect(
      nextCronRun("30 9 * * 1-5", new Date("2026-10-30T08:00:00Z"), DUBAI)?.toISOString(),
    ).toBe("2026-11-02T05:30:00.000Z");
    expect(nextCronRun("0 10 31 * *", new Date("2026-11-01T00:00:00Z"), DUBAI)?.toISOString()).toBe(
      "2026-12-31T06:00:00.000Z",
    );
    expect(nextCronRun("0 0 1 1 *", new Date("2026-12-31T21:00:00Z"), DUBAI)?.toISOString()).toBe(
      "2027-12-31T20:00:00.000Z",
    );
  });
  it("skips a local time that does not exist on a DST spring-forward day", () => {
    // London 30 Mar 2025: 01:00-02:00 does not exist. Daily 01:30 → next real 01:30 is the 31st.
    const next = nextCronRun("30 1 * * *", new Date("2025-03-29T12:00:00Z"), "Europe/London");
    expect(next?.toISOString()).toBe("2025-03-31T00:30:00.000Z");
  });
  it("returns null for an invalid expression or a date that never comes", () => {
    expect(nextCronRun("nope", new Date(), DUBAI)).toBeNull();
    expect(nextCronRun("0 10 31 2 *", new Date("2026-01-01T00:00:00Z"), DUBAI)).toBeNull();
  });
  it("lists upcoming runs in order", () => {
    const runs = upcomingRuns("0 10 * * 1", new Date("2026-10-26T07:00:00Z"), DUBAI, 3);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-11-02T06:00:00.000Z",
      "2026-11-09T06:00:00.000Z",
      "2026-11-16T06:00:00.000Z",
    ]);
  });
});

describe("checkRecurrenceSchedule", () => {
  const now = new Date("2026-10-26T05:00:00Z");
  it("accepts daily, weekly and monthly schedules", () => {
    for (const p of RECURRENCE_PRESETS)
      expect(checkRecurrenceSchedule(p.cron, DUBAI, now)).toBeNull();
  });
  it("refuses more than one run a day, invalid crons, bad timezones and schedules that never run", () => {
    expect(checkRecurrenceSchedule("0 * * * *", DUBAI, now)).toMatch(/once a day/);
    expect(checkRecurrenceSchedule("0 9,17 * * *", DUBAI, now)).toMatch(/once a day/);
    expect(checkRecurrenceSchedule("0 10 * *", DUBAI, now)).toMatch(/not a valid/);
    expect(checkRecurrenceSchedule("0 10 * * *", "Mars/Olympus", now)).toMatch(/timezone/);
    expect(checkRecurrenceSchedule("0 10 30 2 *", DUBAI, now)).toMatch(/never runs/);
  });
});

describe("recurrenceRunDecision (re-checked before every run)", () => {
  const ok = {
    channel: { status: "active", waba_id: "w1", quality_rating: "GREEN" },
    template: { status: "APPROVED", archived_at: null, waba_id: "w1" },
    segmentExists: true,
    mediaProblem: null,
    previousRunActive: false,
    budget: { used: 10, monthly_limit: 100 },
  };
  it("runs when everything is in order (also with no budget set)", () => {
    expect(recurrenceRunDecision(ok)).toEqual({ run: true });
    expect(recurrenceRunDecision({ ...ok, budget: { used: 5000, monthly_limit: null } })).toEqual({
      run: true,
    });
    expect(recurrenceRunDecision({ ...ok, budget: null })).toEqual({ run: true });
  });
  it("skips with the first failing guardrail", () => {
    const cases: Array<[Partial<typeof ok> & Record<string, unknown>, string]> = [
      [{ channel: null } as never, "channel_inactive"],
      [{ channel: { ...ok.channel, status: "paused" } }, "channel_inactive"],
      [{ template: null } as never, "template_missing"],
      [{ template: { ...ok.template, archived_at: "2026-10-01" } } as never, "template_archived"],
      [{ template: { ...ok.template, status: "PAUSED" } }, "template_not_approved"],
      [{ template: { ...ok.template, waba_id: "w2" } }, "waba_mismatch"],
      [{ segmentExists: false }, "segment_missing"],
      [{ channel: { ...ok.channel, quality_rating: "red" } }, "quality_red"],
      [{ mediaProblem: "gone" } as never, "media_unusable"],
      [{ previousRunActive: true }, "previous_run_active"],
      [{ budget: { used: 100, monthly_limit: 100 } }, "budget_reached"],
      [{ budget: { used: 0, monthly_limit: 0 } }, "budget_reached"],
    ];
    for (const [over, reason] of cases)
      expect(recurrenceRunDecision({ ...ok, ...over } as typeof ok)).toEqual({
        run: false,
        reason,
      });
  });
});

describe("monthly budget", () => {
  it("dispatches skip items and only as many sendable items as were granted, in order", () => {
    const items = [
      { recipient_id: "1", body: "a" },
      { recipient_id: "2", skip: "stop_marketing" },
      { recipient_id: "3", body: "b" },
      { recipient_id: "4", body: "c" },
    ];
    const r = applyBudgetGrant(items, 1);
    expect(r.items.map((i) => i.recipient_id)).toEqual(["1", "2"]);
    expect(r.heldBack).toBe(2);
    expect(applyBudgetGrant(items, 0)).toEqual({ items: [items[1]], heldBack: 3 });
    expect(applyBudgetGrant(items, 99)).toEqual({ items, heldBack: 0 });
    expect(applyBudgetGrant(items, -5).heldBack).toBe(3);
  });

  it("shows the meter levels", () => {
    expect(budgetMeter(10, null)).toMatchObject({ level: "none", remaining: null, ratio: null });
    expect(budgetMeter(10, 100)).toMatchObject({ level: "ok", remaining: 90, ratio: 0.1 });
    expect(budgetMeter(85, 100)).toMatchObject({ level: "warn", remaining: 15 });
    expect(budgetMeter(120, 100)).toMatchObject({ level: "reached", remaining: 0, ratio: 1 });
    expect(budgetMeter(0, 0)).toMatchObject({ level: "reached" });
  });

  it("reads and writes the setting, failing closed on a corrupt value", () => {
    expect(readCampaignBudget({})).toEqual({ monthly_limit: null });
    expect(readCampaignBudget({ campaign_budget: { monthly_limit: 5000 } })).toEqual({
      monthly_limit: 5000,
    });
    expect(readCampaignBudget({ campaign_budget: { monthly_limit: "lots" } })).toEqual({
      monthly_limit: 0,
    });
    const next = writeCampaignBudget({ inbox: { x: 1 } }, { monthly_limit: 2000 });
    expect(next).toEqual({ inbox: { x: 1 }, campaign_budget: { monthly_limit: 2000 } });
  });
});
