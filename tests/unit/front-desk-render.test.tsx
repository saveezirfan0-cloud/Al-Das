import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Client components talk to the router and server actions; for a static render they only need to exist.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/front-desk",
}));
vi.mock("@/app/(app)/front-desk/actions", () => ({
  addHandoverNote: async () => ({ ok: true }),
  addToWaitlist: async () => ({ ok: true }),
  cancelFromDesk: async () => ({ ok: true }),
  createDependant: async () => ({ ok: true }),
  getPatientCard: async () => ({ ok: false, error: "x" }),
  linkDependant: async () => ({ ok: true }),
  logCall: async () => ({ ok: true }),
  markNoShow: async () => ({ ok: true }),
  registerWalkIn: async () => ({ ok: true }),
  removeFromWaitlist: async () => ({ ok: true }),
  resolveHandoverNote: async () => ({ ok: true }),
  sendDeskMessageAction: async () => ({ ok: true }),
  setCheckin: async () => ({ ok: true }),
  unlinkDependant: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/appointments/actions", () => ({
  getFreeSlots: async () => ({ ok: true, data: { slots: [] } }),
  moveAppointment: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/contacts/actions", () => ({
  searchContactsQuick: async () => ({ ok: true, data: { rows: [] } }),
}));
vi.mock("@/app/(app)/help/actions", () => ({ submitFeedback: async () => ({ ok: true }) }));

import { FrontDeskWorkspace } from "@/app/(app)/front-desk/front-desk-workspace";
import { PatientCardView } from "@/app/(app)/front-desk/patient-card";
import type { DeskCan, DeskData, DeskOptions } from "@/app/(app)/front-desk/types";
import { HelpMenu } from "@/components/help/help-menu";
import { TrainingBanner } from "@/components/shell/training-banner";
import type { BoardRow, PatientCardData } from "@/lib/front-desk/server";

const options: DeskOptions = {
  timezone: "Asia/Dubai",
  locations: [{ id: "l1", name: "Main clinic" }],
  specialists: [{ id: "s1", name: "Dr Example", location_ids: ["l1"], service_ids: ["v1"] }],
  services: [{ id: "v1", name: "Consultation", duration_min: 30 }],
};
const can: DeskCan = { appointments: true, contacts: true, tasks: true, send: true };

const row = (over: Partial<BoardRow>): BoardRow => ({
  id: "a1",
  number: 1,
  starts_at: "2026-10-14T06:00:00.000Z",
  ends_at: "2026-10-14T06:30:00.000Z",
  status: "awaiting",
  checkin_status: null,
  arrived_at: null,
  is_walk_in: false,
  source: "portal",
  contact_id: "c1",
  specialist_id: "s1",
  reminder: "failed",
  patient_name: "Sara Example",
  phone: "+971500000001",
  specialist_name: "Dr Example",
  service_name: "Consultation",
  location_name: "Main clinic",
  location_id: "l1",
  contact_language: "en",
  with_doctor_at: null,
  done_at: null,
  checked_out_at: null,
  notes_present: false,
  ...over,
});

const data: DeskData = {
  date: "2026-10-14",
  today: "2026-10-14",
  lateGraceMin: 15,
  offersEnabled: false,
  rows: [
    row({}),
    row({
      id: "a2",
      patient_name: "Omar Example",
      status: "confirmed",
      reminder: "sent",
      starts_at: "2026-10-14T07:00:00.000Z",
    }),
    row({
      id: "a3",
      patient_name: "Walk In",
      is_walk_in: true,
      checkin_status: "arrived",
      arrived_at: "2026-10-14T05:50:00.000Z",
      starts_at: "2026-10-14T05:50:00.000Z",
    }),
    row({ id: "a4", patient_name: "Gone Away", status: "cancelled" }),
  ],
  slots: [
    {
      specialist_id: "s1",
      specialist_name: "Dr Example",
      location_id: "l1",
      location_name: "Main clinic",
      date: "2026-10-14",
      slots: [{ starts_at: "2026-10-14T08:00:00.000Z", label: "12:00" }],
    },
  ],
  waitlist: [
    {
      id: "w1",
      contact_id: "c9",
      patient_name: "Wanda Waiter",
      specialist_name: "Dr Example",
      service_name: null,
      location_name: null,
      not_after: null,
      notes: null,
      created_at: "2026-10-12T00:00:00.000Z",
      offer: null,
    },
  ],
  notes: [
    {
      id: "n1",
      body: "Printer is out of paper",
      pinned: true,
      created_at: "2026-10-14T03:00:00.000Z",
      author: "Nadia Example",
      resolved_at: null,
    },
  ],
};

describe("Front desk rendering", () => {
  it("renders the board with counts, check-in buttons and the call hint", () => {
    const html = renderToStaticMarkup(
      <FrontDeskWorkspace data={data} options={options} can={can} />,
    );
    expect(html).toContain("Sara Example");
    expect(html).toContain("Omar Example");
    expect(html).toContain("Walk-in");
    expect(html).not.toContain("Gone Away"); // cancelled stay out of the list (counted in the header)
    expect(html).toContain("1 cancelled");
    expect(html).toContain("Arrived"); // the next step for someone who has not arrived
    expect(html).toContain("With doctor"); // the next step for the person who has
    expect(html).toContain(">Call<"); // the failed reminder tells the desk to ring
    expect(html).toContain("Find a patient");
    expect(html).toContain("Unconfirmed");
  });

  it("hides every write button from someone who can only look", () => {
    const html = renderToStaticMarkup(
      <FrontDeskWorkspace
        data={data}
        options={options}
        can={{ appointments: false, contacts: false, tasks: false, send: false }}
      />,
    );
    expect(html).toContain("Sara Example");
    expect(html).not.toContain("Walk-in </kbd>");
    expect(html).not.toMatch(/>Arrived</);
    expect(html).not.toContain("No-show</button>");
  });
});

const card: PatientCardData = {
  now: "2026-10-14T05:00:00.000Z",
  contact: {
    id: "c1",
    name: "Layla Example",
    phone: "+971500000201",
    has_bsuid: false,
    language: "en",
    dob: "1988-03-02",
    stop_marketing: true,
  },
  next_appointment: {
    id: "a1",
    number: 7,
    starts_at: "2026-10-15T06:00:00.000Z",
    status: "awaiting",
    checkin_status: null,
    specialist_name: "Dr Example",
    service_name: "Consultation",
    location_name: "Main clinic",
  },
  last_visit: null,
  open_enquiry: { id: "e1", number: 12, title: "Check-up package", stage: "Contacted" },
  household: {
    guardian: null,
    dependants: [
      { id: "k1", link_id: "h1", name: "Omar Example", next_starts_at: "2026-10-16T06:00:00.000Z" },
    ],
  },
  open_call_tasks: 1,
  waitlist: [],
  flags: [{ key: "stop_marketing", label: "No marketing messages", tone: "warn" }],
};

describe("Patient card rendering", () => {
  it("shows next appointment, enquiry, household, flags and the one-tap actions", () => {
    const html = renderToStaticMarkup(<PatientCardView card={card} options={options} can={can} />);
    expect(html).toContain("Layla Example");
    expect(html).toContain("No marketing messages");
    expect(html).toContain("Unconfirmed");
    expect(html).toContain("#12 Check-up package");
    expect(html).toContain("Omar Example");
    expect(html).toContain('href="tel:+971500000201"');
    for (const label of ["Book", "Move", "Cancel", "Location", "Running late", "Waitlist"])
      expect(html).toContain(label);
    expect(html).toContain("/appointments?new=c1");
  });

  it("offers a dependant the guardian's number to call, and no Call link when there is none", () => {
    const kid: PatientCardData = {
      ...card,
      contact: { ...card.contact, id: "k1", name: "Omar Example", phone: null },
      household: {
        guardian: { id: "c1", name: "Layla Example", phone: "+971500000201" },
        dependants: [],
      },
    };
    const html = renderToStaticMarkup(<PatientCardView card={kid} options={options} can={can} />);
    expect(html).toContain("Dependant of");
    expect(html).toContain('href="tel:+971500000201"');
    const none: PatientCardData = { ...kid, household: { guardian: null, dependants: [] } };
    expect(
      renderToStaticMarkup(<PatientCardView card={none} options={options} can={can} />),
    ).not.toContain("tel:");
  });

  it("drops the buttons a person has no permission for", () => {
    const html = renderToStaticMarkup(
      <PatientCardView
        card={card}
        options={options}
        can={{ appointments: false, contacts: false, tasks: false, send: false }}
      />,
    );
    expect(html).not.toContain("Running late");
    expect(html).not.toContain(">Book<");
    expect(html).not.toContain("Waitlist");
  });
});

describe("Help and training chrome", () => {
  it("renders the training banner and the ? button", () => {
    expect(renderToStaticMarkup(<TrainingBanner />)).toContain("TRAINING MODE");
    expect(renderToStaticMarkup(<TrainingBanner />)).toContain("never contacts WhatsApp");
    const help = renderToStaticMarkup(<HelpMenu roleName="Receptionist" videos={{}} />);
    expect(help).toContain("Help for this page");
  });
});
