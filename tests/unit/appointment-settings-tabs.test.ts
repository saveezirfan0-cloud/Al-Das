import { describe, expect, it } from "vitest";

import { APPOINTMENT_SETTINGS_TABS, initialSettingsTab } from "@/lib/appointments/settings-tabs";

describe("initialSettingsTab", () => {
  it("keeps the set-up order: locations, services, then doctors", () => {
    const at = (t: string) => APPOINTMENT_SETTINGS_TABS.indexOf(t as never);
    expect(at("locations")).toBe(0);
    expect(at("locations")).toBeLessThan(at("services"));
    expect(at("services")).toBeLessThan(at("doctors"));
  });

  it("opens on Locations while there are none, else Doctors", () => {
    expect(initialSettingsTab(undefined, 0)).toBe("locations");
    expect(initialSettingsTab(undefined, 2)).toBe("doctors");
  });

  it("honours a known ?tab= and ignores anything else", () => {
    expect(initialSettingsTab("services", 0)).toBe("services");
    expect(initialSettingsTab("rules", 3)).toBe("rules");
    expect(initialSettingsTab("specialists", 0)).toBe("locations");
    expect(initialSettingsTab(["services"], 1)).toBe("doctors");
  });
});
