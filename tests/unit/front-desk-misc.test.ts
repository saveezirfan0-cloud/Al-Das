import { describe, expect, it } from "vitest";

import { landingPathFor } from "@/lib/front-desk/landing";
import {
  ageLabel,
  cardFlags,
  pickLastVisit,
  pickNextAppointment,
  quickReplyAppointmentValues,
} from "@/lib/front-desk/patient-card";
import { registrationMessage, whatsappDeskLink } from "@/lib/front-desk/qr";
import {
  DEFAULT_FRONT_DESK_SETTINGS,
  readFrontDeskSettings,
  writeFrontDeskSettings,
} from "@/lib/front-desk/settings";
import {
  isSimulatedWaMessageId,
  simulatedWaMessageId,
  TRAINING_BLOCKED_MESSAGE,
} from "@/lib/training/simulate";

const now = new Date("2026-10-14T09:00:00Z");

describe("landing page by role", () => {
  const base = { status: "active" as const };
  it("sends the Receptionist role to the front desk and everyone else to the dashboard", () => {
    expect(
      landingPathFor({ ...base, roleName: "Receptionist", permissions: ["frontdesk.use"] }),
    ).toBe("/front-desk");
    expect(
      landingPathFor({ ...base, roleName: "receptionist", permissions: ["frontdesk.use"] }),
    ).toBe("/front-desk");
    expect(landingPathFor({ ...base, roleName: "Manager", permissions: ["frontdesk.use"] })).toBe(
      "/dashboard",
    );
    expect(landingPathFor({ ...base, roleName: "Admin", permissions: ["*"] })).toBe("/dashboard");
  });
  it("never lands someone on a page they cannot open", () => {
    expect(
      landingPathFor({ ...base, roleName: "Receptionist", permissions: ["appointments.view"] }),
    ).toBe("/dashboard");
    expect(
      landingPathFor({
        status: "suspended",
        roleName: "Receptionist",
        permissions: ["frontdesk.use"],
      }),
    ).toBe("/dashboard");
  });
});

describe("patient card", () => {
  const appts = [
    { starts_at: "2026-10-20T06:00:00Z", status: "confirmed", checkin_status: null },
    { starts_at: "2026-10-15T06:00:00Z", status: "awaiting", checkin_status: null },
    { starts_at: "2026-10-14T06:00:00Z", status: "cancelled", checkin_status: null },
    { starts_at: "2026-09-01T06:00:00Z", status: "completed", checkin_status: null },
    { starts_at: "2026-10-01T06:00:00Z", status: "awaiting", checkin_status: "done" },
    { starts_at: "2026-08-01T06:00:00Z", status: "no_show", checkin_status: null },
  ];
  it("picks the next live appointment and the last visit that really happened", () => {
    expect(pickNextAppointment(appts, now)?.starts_at).toBe("2026-10-15T06:00:00Z");
    expect(pickLastVisit(appts, now)?.starts_at).toBe("2026-10-01T06:00:00Z");
    expect(pickNextAppointment([], now)).toBeNull();
    expect(pickLastVisit([appts[5]], now)).toBeNull();
  });

  it("raises the flags reception must not miss", () => {
    const flags = cardFlags({
      stop_marketing: true,
      has_phone: false,
      has_bsuid: false,
      dob: null,
      no_shows_12m: 3,
      open_call_tasks: 2,
      waitlist_entries: 1,
      guardian: null,
      dependants: 2,
    });
    expect(flags.map((f) => f.key)).toEqual([
      "stop_marketing",
      "no_whatsapp",
      "no_shows",
      "open_calls",
      "waitlist",
      "guardian",
    ]);
    expect(flags.find((f) => f.key === "no_shows")?.tone).toBe("alert");
    expect(
      cardFlags({
        stop_marketing: false,
        has_phone: true,
        has_bsuid: false,
        dob: null,
        no_shows_12m: 0,
        open_call_tasks: 0,
        waitlist_entries: 0,
        guardian: null,
        dependants: 0,
      }),
    ).toEqual([]);
    expect(
      cardFlags({
        stop_marketing: false,
        has_phone: false,
        has_bsuid: false,
        dob: null,
        no_shows_12m: 0,
        open_call_tasks: 0,
        waitlist_entries: 0,
        guardian: { id: "g", name: "Layla" },
        dependants: 0,
      }).map((f) => f.key),
    ).toEqual(["dependant"]); // a dependant needs no phone of their own
  });

  it("labels age and quick-reply values", () => {
    expect(ageLabel("2019-06-11", now)).toBe("7 y");
    expect(ageLabel("2026-05-11", now)).toBe("5 mo");
    expect(ageLabel(null, now)).toBeNull();
    expect(
      quickReplyAppointmentValues(
        { starts_at: "x", specialist_name: "Dr E", location_name: "Main" },
        () => ({ date: "Thu 15 Oct", time: "10:00 AM" }),
      ),
    ).toEqual({
      doctor: "Dr E",
      appointment_date: "Thu 15 Oct",
      appointment_time: "10:00 AM",
      location: "Main",
    });
    expect(quickReplyAppointmentValues(null, () => ({ date: "", time: "" })).doctor).toBeNull();
  });
});

describe("desk QR link", () => {
  it("builds a wa.me link with the registration text and nothing personal", () => {
    expect(whatsappDeskLink("+971500000100", "Hello, I would like to register")).toBe(
      "https://wa.me/971500000100?text=Hello%2C%20I%20would%20like%20to%20register",
    );
    expect(whatsappDeskLink("+971500000100", "  ")).toBe("https://wa.me/971500000100");
    expect(whatsappDeskLink("0500000100", "x")).toBeNull();
    expect(whatsappDeskLink("+971500000100", "x".repeat(500))?.length).toBeLessThan(300);
  });
  it("prefers Arabic for Arabic and falls back to English", () => {
    const s = { registration_message_en: "Hello", registration_message_ar: "مرحبا" };
    expect(registrationMessage(s, "ar")).toBe("مرحبا");
    expect(registrationMessage({ ...s, registration_message_ar: "" }, "ar")).toBe("Hello");
  });
});

describe("front desk settings", () => {
  it("defaults to everything that sends a message being OFF", () => {
    expect(DEFAULT_FRONT_DESK_SETTINGS.offers_enabled).toBe(false);
    expect(DEFAULT_FRONT_DESK_SETTINGS.offer_template_id).toBeNull();
    expect(DEFAULT_FRONT_DESK_SETTINGS.offer_batch_size).toBe(1);
  });
  it("reads tolerantly and writes without touching other sections", () => {
    expect(readFrontDeskSettings(null)).toEqual(DEFAULT_FRONT_DESK_SETTINGS);
    expect(readFrontDeskSettings({ front_desk: { offer_ttl_minutes: 9999 } })).toEqual(
      DEFAULT_FRONT_DESK_SETTINGS,
    );
    const written = writeFrontDeskSettings(
      { appointments: { a: 1 } },
      { ...DEFAULT_FRONT_DESK_SETTINGS, offers_enabled: true },
    );
    expect(written.appointments).toEqual({ a: 1 });
    expect(readFrontDeskSettings(written).offers_enabled).toBe(true);
  });
});

describe("training mode helpers", () => {
  it("makes unique, recognisable stand-in message ids", () => {
    const id = simulatedWaMessageId("11111111-1111-1111-1111-111111111111");
    expect(id).toBe("training:11111111-1111-1111-1111-111111111111");
    expect(isSimulatedWaMessageId(id)).toBe(true);
    expect(isSimulatedWaMessageId("wamid.HBgM")).toBe(false);
    expect(isSimulatedWaMessageId(null)).toBe(false);
    expect(TRAINING_BLOCKED_MESSAGE).toMatch(/never contacts WhatsApp/);
  });
});
