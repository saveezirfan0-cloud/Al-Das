/** Settings, Appointments tabs, in the order a new clinic fills them in: branches, what is offered, who offers it. */
export const APPOINTMENT_SETTINGS_TABS = [
  "locations",
  "departments",
  "services",
  "doctors",
  "rules",
] as const;
export type AppointmentSettingsTab = (typeof APPOINTMENT_SETTINGS_TABS)[number];

/**
 * The tab the page opens on: the one asked for in ?tab= (links from the Go-live checklist), else Locations while there
 * are none (nothing else can be set up without a branch), else Doctors.
 */
export function initialSettingsTab(asked: unknown, locations: number): AppointmentSettingsTab {
  const known = APPOINTMENT_SETTINGS_TABS.find((t) => t === asked);
  if (known) return known;
  return locations === 0 ? "locations" : "doctors";
}
