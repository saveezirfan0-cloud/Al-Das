import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResourceGrid } from "@/app/(app)/appointments/resource-grid";
import type { ApptRow, SpecialistOption } from "@/app/(app)/appointments/types";

// 2026-10-12 is a Monday; Asia/Dubai is UTC+4.
const specialist: SpecialistOption = {
  id: "s1",
  name: "Dr Example",
  title: "GP",
  department_id: null,
  location_ids: ["l1"],
  service_ids: [],
  working_hours: [{ location_id: "l1", weekday: 1, start_min: 9 * 60, end_min: 12 * 60 }],
};

const appt: ApptRow = {
  id: "a1",
  number: 7,
  contact_id: "c1",
  contact_name: "Sara Test",
  phone: null,
  status: "confirmed",
  starts_at: "2026-10-12T05:30:00.000Z", // 09:30 local
  ends_at: "2026-10-12T06:00:00.000Z",
  location_id: "l1",
  specialist_id: "s1",
  service_id: null,
  department_id: null,
  channel_name: null,
  source: "portal",
  external_id: null,
  notes: null,
  notify_early: false,
  created_at: "2026-10-01T00:00:00.000Z",
  reminder: null,
};

const base = {
  date: "2026-10-12",
  timezone: "Asia/Dubai",
  locationId: "l1",
  specialists: [specialist],
  appointments: [appt],
  blocks: [],
  workingWeekdays: [1, 2, 3, 4, 5, 6],
  holidays: [],
  granularity: 15,
  canManage: true,
  onSlotClick: () => {},
  onAppointmentClick: () => {},
  onBlockClick: () => {},
};

describe("ResourceGrid", () => {
  it("renders a column per specialist with the booking at its local time", () => {
    const html = renderToStaticMarkup(<ResourceGrid {...base} />);
    expect(html).toContain("Dr Example");
    expect(html).toContain("Sara Test");
    expect(html).toContain("09:30–10:00");
    // axis starts at the first working hour: 09:00 → 09:30 is 30 min * 1.1px = 33px from the top
    expect(html).toContain("top:33px");
  });

  it("says so when the clinic is closed that day", () => {
    const html = renderToStaticMarkup(<ResourceGrid {...base} holidays={["2026-10-12"]} />);
    expect(html).toContain("clinic is closed");
  });

  it("explains an empty location", () => {
    const html = renderToStaticMarkup(<ResourceGrid {...base} specialists={[]} />);
    expect(html).toContain("No specialists work at this location");
  });
});
