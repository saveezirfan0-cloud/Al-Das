import { describe, expect, it } from "vitest";

import { ageBand } from "@/lib/contacts/age-band";
import {
  DEFAULT_LIFECYCLE_THRESHOLDS,
  lifecycleStage,
  type LifecycleStage,
} from "@/lib/contacts/lifecycle";
import {
  lifecycleSettingsSchema,
  readLifecycleSettings,
  writeLifecycleSettings,
} from "@/lib/contacts/lifecycle-settings";

import fx from "./fixtures/lifecycle.synthetic.json";

describe("lifecycleStage against the shared fixture (SQL parity is in tests/db/lifecycle-segments.test.ts)", () => {
  for (const c of fx.lifecycle) {
    it(c.name, () => {
      const t = {
        newPatientDays: c.newPatientDays ?? DEFAULT_LIFECYCLE_THRESHOLDS.newPatientDays,
        activeMonths: c.activeMonths ?? DEFAULT_LIFECYCLE_THRESHOLDS.activeMonths,
      };
      expect(
        lifecycleStage(
          { unitePin: c.pin, firstVisitDate: c.first, lastVisitDate: c.last },
          c.today,
          t,
        ),
      ).toBe(c.expected as LifecycleStage);
    });
  }
});

describe("ageBand against the shared fixture", () => {
  for (const c of fx.ageBand) {
    it(`${c.dob} on ${c.today}`, () => expect(ageBand(c.dob, c.today)).toBe(c.expected));
  }
});

describe("lifecycle settings", () => {
  for (const c of fx.settings) {
    it(c.name, () => expect(readLifecycleSettings(c.settings)).toEqual(c.expected));
  }
  it("writes only the lifecycle block and keeps other keys", () => {
    const next = writeLifecycleSettings(
      { organisation: { expiry_lead_days: 30 } },
      {
        newPatientDays: 45,
        activeMonths: 12,
      },
    );
    expect(next).toEqual({
      organisation: { expiry_lead_days: 30 },
      lifecycle: { newPatientDays: 45, activeMonths: 12 },
    });
  });
  it("refuses out-of-range values", () => {
    expect(lifecycleSettingsSchema.safeParse({ newPatientDays: 0, activeMonths: 18 }).success).toBe(
      false,
    );
    expect(
      lifecycleSettingsSchema.safeParse({ newPatientDays: 90, activeMonths: 61 }).success,
    ).toBe(false);
    expect(
      lifecycleSettingsSchema.safeParse({ newPatientDays: 1.5, activeMonths: 6 }).success,
    ).toBe(false);
  });
});
