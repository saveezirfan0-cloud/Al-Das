/**
 * Fills an EMPTY demo workspace with synthetic data (see lib/demo/data.ts). Called by scripts/demo-reset.ts after
 * public.demo_wipe_org, and by the database test. Every row is made up: no real patient, doctor or phone number.
 *
 * It only writes through the service-role client it is given and never calls Meta, Unite or any other service:
 * the finance rows come from the synthetic builders in tests/unit/finance and go through the normal raw-batch processing.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { processBatch, type ProcessDeps } from "../finance/process-batch";
import { demoFinanceBatch } from "./finance";
import type { Database, Json } from "../supabase/types";
import {
  CAMPAIGN_OUTCOMES,
  conversationSpecs,
  DEMO_INBOUND_AR,
  DEMO_INBOUND_EN,
  DEMO_NOTES,
  DEMO_OUTBOUND_EN,
  demoPerson,
  demoPhone,
  DEPARTMENTS,
  DOCTORS,
  LOCATIONS,
  PIPELINES,
  rng,
  SERVICES,
} from "./data";

type Admin = SupabaseClient<Database>;
type TableName = keyof Database["public"]["Tables"];

export type DemoSummary = Record<string, number>;

export type SeedOptions = {
  orgId: string;
  /** The workspace slug; makes the fake WhatsApp ids unique when several demo workspaces share a database. */
  slug?: string;
  /** Who the conversations, tasks and notes are attributed to (members of the org). */
  staff: { adminId: string; receptionistId?: string | null; financeId?: string | null };
  now?: Date;
  timezone?: string;
};

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();
const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * HOUR);

/** Insert in chunks; on failure report the table and Postgres code, never the rows (they are patient-shaped). */
async function ins<T extends TableName>(
  admin: Admin,
  table: T,
  rows: Array<Database["public"]["Tables"][T]["Insert"]>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 150) {
    // Rows differ in which optional columns they set: let the database default the ones a row leaves out
    // (otherwise PostgREST would send NULL for them and trip NOT NULL columns such as is_walk_in).
    const { error } = await admin
      .from(table)
      .insert(rows.slice(i, i + 150) as never, { defaultToNull: false });
    if (error)
      throw new Error(
        `demo seed: insert into ${table} failed (${error.code}): ${error.message.slice(0, 160)}`,
      );
  }
}

/** Local midnight (clinic time) of the day containing `at`, as an instant. */
function localDayStart(at: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  // Find the UTC instant whose clinic-local date/time is ymd 00:00 by checking the zone offset at that day.
  const guess = new Date(`${ymd}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMin * 60_000);
}

function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export async function seedDemoWorkspace(admin: Admin, opts: SeedOptions): Promise<DemoSummary> {
  const org = opts.orgId;
  const now = opts.now ?? new Date();
  const tz = opts.timezone ?? "Asia/Dubai";
  const r = rng(20261014);
  const slug = (opts.slug ?? "demo").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "demo";
  const wabaId = `demo-waba-${slug}`;
  const counts: DemoSummary = {};
  const count = (k: string, n: number) => (counts[k] = (counts[k] ?? 0) + n);
  const { adminId, receptionistId = null, financeId = null } = opts.staff;
  const deskUser = receptionistId ?? adminId;

  // ---------------------------------------------------------------------------------------------- places and people
  const locationIds = LOCATIONS.map(() => randomUUID());
  await ins(
    admin,
    "locations",
    LOCATIONS.map((l, i) => ({
      id: locationIds[i],
      org_id: org,
      name: l.name,
      timezone: tz,
      address: l.address,
      latitude: l.latitude,
      longitude: l.longitude,
      maps_url: "https://maps.example.test/demo-clinic",
    })),
  );
  const deptIds = DEPARTMENTS.map(() => randomUUID());
  await ins(
    admin,
    "departments",
    DEPARTMENTS.map((name, i) => ({ id: deptIds[i], org_id: org, name })),
  );
  const serviceIds = SERVICES.map(() => randomUUID());
  await ins(
    admin,
    "services",
    SERVICES.map((s, i) => ({
      id: serviceIds[i],
      org_id: org,
      department_id: deptIds[s.dept],
      name: s.name,
      duration_min: s.minutes,
      price: s.price,
    })),
  );
  const doctorIds = DOCTORS.map(() => randomUUID());
  await ins(
    admin,
    "specialists",
    DOCTORS.map((d, i) => ({
      id: doctorIds[i],
      org_id: org,
      name: d.name,
      department_id: deptIds[d.dept],
      title: "Doctor",
    })),
  );
  await ins(
    admin,
    "specialist_locations",
    DOCTORS.map((d, i) => ({
      org_id: org,
      specialist_id: doctorIds[i],
      location_id: locationIds[d.location],
    })),
  );
  await ins(
    admin,
    "specialist_services",
    DOCTORS.flatMap((d, i) =>
      d.services.map((s) => ({
        org_id: org,
        specialist_id: doctorIds[i],
        service_id: serviceIds[s],
      })),
    ),
  );
  await ins(
    admin,
    "working_hours",
    DOCTORS.flatMap((d, i) =>
      [1, 2, 3, 4, 5, 6].map((weekday) => ({
        org_id: org,
        specialist_id: doctorIds[i],
        location_id: locationIds[d.location],
        weekday,
        start_min: 540,
        end_min: 1020,
      })),
    ),
  );
  count("locations", LOCATIONS.length);
  count("specialists", DOCTORS.length);
  count("services", SERVICES.length);

  // Patients: 60 with a (fictional) phone, plus 6 children who have none and hang under a parent.
  const people = Array.from({ length: 60 }, (_, i) => demoPerson(i));
  const patientIds = people.map(() => randomUUID());
  await ins(
    admin,
    "contacts",
    people.map((p, i) => ({
      id: patientIds[i],
      org_id: org,
      first_name: p.first,
      last_name: p.last,
      phone_e164: p.phone,
      language: p.language,
      dob: p.dob,
      source: i % 5 === 0 ? "whatsapp" : "manual",
      promotions_opt_in: i % 4 === 0,
      stop_marketing: i % 17 === 0,
      last_interaction_at: iso(ago(now, 1 + i * 3)),
      created_by: adminId,
    })),
  );
  const kids = [
    { parent: 0, first: "Rami", dob: "2018-04-02" },
    { parent: 0, first: "Dana", dob: "2021-09-17" },
    { parent: 1, first: "Noor", dob: "2016-12-30" },
    { parent: 1, first: "Sami", dob: "2020-03-08" },
    { parent: 3, first: "Hala", dob: "2019-06-11" },
    { parent: 4, first: "Zed", dob: "2022-01-25" },
  ];
  const kidIds = kids.map(() => randomUUID());
  await ins(
    admin,
    "contacts",
    kids.map((k, i) => ({
      id: kidIds[i],
      org_id: org,
      first_name: k.first,
      last_name: people[k.parent].last,
      language: people[k.parent].language,
      dob: k.dob,
      source: "manual",
      created_by: adminId,
    })),
  );
  await ins(
    admin,
    "household_links",
    kids.map((k, i) => ({
      org_id: org,
      guardian_contact_id: patientIds[k.parent],
      dependant_contact_id: kidIds[i],
      relationship: "child",
      created_by: deskUser,
    })),
  );
  count("contacts", people.length + kids.length);
  count("household_links", kids.length);

  const tagIds = ["Chronic care", "VIP", "Corporate", "Newsletter"].map(() => randomUUID());
  await ins(
    admin,
    "tags",
    ["Chronic care", "VIP", "Corporate", "Newsletter"].map((name, i) => ({
      id: tagIds[i],
      org_id: org,
      name,
      scope: "contact",
      color: ["blue", "amber", "green", "gray"][i],
    })),
  );
  await ins(
    admin,
    "contact_tags",
    patientIds
      .slice(0, 24)
      .map((id, i) => ({ org_id: org, contact_id: id, tag_id: tagIds[i % 4], added_by: adminId })),
  );

  // ----------------------------------------------------------------------------------- channel, templates, replies
  const channelId = randomUUID();
  await ins(admin, "channels", [
    {
      id: channelId,
      org_id: org,
      name: "Demo WhatsApp",
      waba_id: wabaId,
      phone_number_id: `demo-phone-number-${slug}`,
      display_phone: "+44 7700 900000",
      verified_name: "Pulse Demo Clinic",
      quality_rating: "GREEN",
      messaging_limit_tier: "TIER_1K",
    },
  ]);
  const template = (
    name: string,
    category: string,
    status: string,
    body: string,
    buttons?: string[],
    map?: Record<string, string>,
  ) => ({
    id: randomUUID(),
    org_id: org,
    channel_id: channelId,
    waba_id: wabaId,
    name,
    language: "en",
    category,
    status,
    components: [
      { type: "BODY", text: body },
      ...(buttons
        ? [{ type: "BUTTONS", buttons: buttons.map((text) => ({ type: "QUICK_REPLY", text })) }]
        : []),
    ] as unknown as NonNullable<Json>,
    variable_map: (map ?? {}) as unknown as NonNullable<Json>,
    last_synced_at: iso(now),
  });
  const tReminder = template(
    "appointment_reminder",
    "UTILITY",
    "APPROVED",
    "Hello {{1}}, a reminder of your appointment on {{2}} with {{3}}.",
    ["Confirm", "Reschedule", "Cancel"],
  );
  const tOffer = template(
    "slot_offer",
    "UTILITY",
    "APPROVED",
    "A place has opened with {{1}} on {{2}}. Would you like it?",
    ["Yes, book it", "No thanks"],
    {
      "body.1": "appointment.specialist",
      "body.2": "appointment.datetime",
    },
  );
  const tFlu = template(
    "flu_season_reminder",
    "MARKETING",
    "APPROVED",
    "Hello {{1}}, flu vaccinations are now available at Pulse Demo Clinic.",
    ["Book now", "Not now"],
    { "body.1": "contact.first_name" },
  );
  const tBirthday = template(
    "birthday_greeting",
    "MARKETING",
    "APPROVED",
    "Happy birthday {{1}} from all of us at Pulse Demo Clinic!",
    undefined,
    { "body.1": "contact.first_name" },
  );
  const tPending = template(
    "health_check_invite",
    "MARKETING",
    "PENDING",
    "Hello {{1}}, book your annual health check today.",
    undefined,
    { "body.1": "contact.first_name" },
  );
  await ins(admin, "wa_templates", [tReminder, tOffer, tFlu, tBirthday, tPending]);
  count("templates", 5);

  await ins(admin, "quick_replies", [
    {
      org_id: org,
      shortcut: "hello",
      text: "Hello {{first_name}}, this is {{agent_name}} from {{clinic_name}}. How can I help?",
      text_ar: "مرحبا {{first_name}}، معك {{agent_name}} من {{clinic_name}}. كيف يمكنني مساعدتك؟",
    },
    {
      org_id: org,
      shortcut: "hours",
      text: "We are open 9 am to 5 pm, Monday to Saturday.",
      text_ar: "ساعات عملنا من 9 صباحا إلى 5 مساء من الاثنين إلى السبت.",
    },
    {
      org_id: org,
      shortcut: "visit",
      text: "Your next visit is on {{appointment_date}} at {{appointment_time}} with {{doctor}} at {{location}}.",
      text_ar:
        "موعدك القادم يوم {{appointment_date}} الساعة {{appointment_time}} مع {{doctor}} في {{location}}.",
    },
    {
      org_id: org,
      shortcut: "thanks",
      text: "Thank you {{first_name}}. Is there anything else we can do?",
      text_ar: "شكرا لك {{first_name}}. هل هناك شيء آخر نستطيع مساعدتك به؟",
    },
    { org_id: org, shortcut: "callback", text: "We will call you back shortly on this number." },
  ]);
  count("quick_replies", 5);

  // ---------------------------------------------------------------------------------------------- appointments
  const today0 = localDayStart(now, tz);
  const tomorrow0 = new Date(today0.getTime() + 24 * HOUR);
  // The "now" of the demo day, kept inside clinic hours so that the whole plan (from 3.5 hours ago to 4.5 hours
  // ahead) falls on today whatever time the reset is run: never earlier than 11:00 or later than 18:30 local.
  const rounded = Math.floor(now.getTime() / (30 * 60_000)) * 30 * 60_000;
  const anchor = new Date(
    Math.min(Math.max(rounded, today0.getTime() + 11 * HOUR), today0.getTime() + 18.5 * HOUR),
  );
  type Appt = Database["public"]["Tables"]["appointments"]["Insert"];
  const appts: Appt[] = [];
  const addAppt = (
    a: Omit<Appt, "org_id" | "id" | "ends_at" | "starts_at"> & {
      startsAt: Date;
      patient: number | string;
      doctor: number;
      service: number;
    },
  ) => {
    const svc = SERVICES[a.service];
    const doctor = DOCTORS[a.doctor];
    const { startsAt, patient, doctor: d, service: s, ...rest } = a;
    void d;
    void s;
    appts.push({
      ...rest,
      id: randomUUID(),
      org_id: org,
      contact_id: typeof patient === "number" ? patientIds[patient] : patient,
      location_id: locationIds[doctor.location],
      specialist_id: doctorIds[a.doctor],
      service_id: serviceIds[a.service],
      department_id: deptIds[doctor.dept],
      starts_at: iso(startsAt),
      ends_at: iso(new Date(startsAt.getTime() + svc.minutes * 60_000)),
      created_by: deskUser,
    } as Appt);
  };

  // Today: a spread of states around "now" so the board always shows a living day.
  const todayPlan: Array<{
    offsetMin: number;
    patient: number;
    doctor: number;
    service: number;
    state:
      | "checked_out"
      | "done"
      | "with_doctor"
      | "arrived"
      | "no_show"
      | "late"
      | "confirmed"
      | "awaiting"
      | "cancelled";
  }> = [
    { offsetMin: -210, patient: 5, doctor: 0, service: 0, state: "checked_out" },
    { offsetMin: -180, patient: 6, doctor: 1, service: 0, state: "checked_out" },
    { offsetMin: -150, patient: 7, doctor: 2, service: 2, state: "done" },
    { offsetMin: -120, patient: 8, doctor: 0, service: 1, state: "no_show" },
    { offsetMin: -60, patient: 9, doctor: 1, service: 0, state: "with_doctor" },
    { offsetMin: -30, patient: 10, doctor: 2, service: 3, state: "arrived" },
    { offsetMin: -25, patient: 11, doctor: 3, service: 4, state: "late" },
    { offsetMin: 0, patient: 12, doctor: 0, service: 0, state: "arrived" },
    { offsetMin: 30, patient: 13, doctor: 1, service: 1, state: "confirmed" },
    { offsetMin: 60, patient: 14, doctor: 4, service: 0, state: "confirmed" },
    { offsetMin: 90, patient: 15, doctor: 3, service: 4, state: "awaiting" },
    { offsetMin: 120, patient: 16, doctor: 2, service: 2, state: "confirmed" },
    { offsetMin: 150, patient: 17, doctor: 0, service: 5, state: "awaiting" },
    { offsetMin: 180, patient: 18, doctor: 4, service: 1, state: "cancelled" },
  ];
  for (const p of todayPlan) {
    const startsAt = new Date(anchor.getTime() + p.offsetMin * 60_000);
    const checkin: Partial<Appt> = {};
    const arrivedAt = new Date(startsAt.getTime() - 5 * 60_000);
    if (["checked_out", "done", "with_doctor", "arrived"].includes(p.state)) {
      checkin.arrived_at = iso(arrivedAt);
      checkin.checkin_status = p.state === "late" ? null : p.state;
      if (["checked_out", "done", "with_doctor"].includes(p.state))
        checkin.with_doctor_at = iso(new Date(startsAt.getTime() + 5 * 60_000));
      if (["checked_out", "done"].includes(p.state))
        checkin.done_at = iso(new Date(startsAt.getTime() + 25 * 60_000));
      if (p.state === "checked_out")
        checkin.checked_out_at = iso(new Date(startsAt.getTime() + 32 * 60_000));
    }
    addAppt({
      startsAt,
      patient: p.patient,
      doctor: p.doctor,
      service: p.service,
      status:
        p.state === "no_show"
          ? "no_show"
          : p.state === "cancelled"
            ? "cancelled"
            : p.state === "awaiting" || p.state === "late"
              ? "awaiting"
              : "confirmed",
      source: "portal",
      ...checkin,
    });
  }
  // Two walk-ins registered at the desk.
  addAppt({
    startsAt: new Date(anchor.getTime() - 15 * 60_000),
    patient: 40,
    doctor: 1,
    service: 0,
    status: "confirmed",
    source: "portal",
    is_walk_in: true,
    checkin_status: "arrived",
    arrived_at: iso(ago(now, 0.2)),
  });
  addAppt({
    startsAt: new Date(anchor.getTime() - 90 * 60_000),
    patient: 41,
    doctor: 4,
    service: 0,
    status: "confirmed",
    source: "portal",
    is_walk_in: true,
    checkin_status: "done",
    arrived_at: iso(ago(now, 1.6)),
    with_doctor_at: iso(ago(now, 1.4)),
    done_at: iso(ago(now, 1.0)),
  });
  // A child's appointment: her reminders go to her mother's number.
  addAppt({
    startsAt: new Date(anchor.getTime() + 210 * 60_000),
    patient: kidIds[0],
    doctor: 0,
    service: 0,
    status: "awaiting",
    source: "portal",
  });
  // Two read-only rows that came from Unite.
  addAppt({
    startsAt: new Date(anchor.getTime() + 240 * 60_000),
    patient: 19,
    doctor: 4,
    service: 0,
    status: "confirmed",
    source: "unite",
    external_id: "DEMO-UNITE-0001",
    external_status: "ACF",
  });
  addAppt({
    startsAt: new Date(anchor.getTime() + 270 * 60_000),
    patient: 20,
    doctor: 1,
    service: 1,
    status: "awaiting",
    source: "unite",
    external_id: "DEMO-UNITE-0002",
    external_status: "YTC",
  });

  // Tomorrow: mostly unconfirmed, with a mix of reminder fates.
  const tomorrowTimes = [
    9 * 60,
    9 * 60 + 30,
    10 * 60,
    10 * 60 + 30,
    11 * 60,
    11 * 60 + 30,
    13 * 60,
    14 * 60,
    14 * 60 + 30,
    15 * 60,
    15 * 60 + 30,
    16 * 60,
  ];
  tomorrowTimes.forEach((min, i) => {
    addAppt({
      startsAt: new Date(tomorrow0.getTime() + min * 60_000),
      patient: 21 + i,
      doctor: i % DOCTORS.length,
      service: DOCTORS[i % DOCTORS.length].services[0],
      status: i % 4 === 0 ? "confirmed" : "awaiting",
      source: "portal",
    });
  });
  // Recent history (so cards show a last visit) and the next two weeks.
  for (let i = 0; i < 10; i++)
    addAppt({
      startsAt: new Date(today0.getTime() - (i + 2) * 24 * HOUR + 10 * HOUR),
      patient: 30 + i,
      doctor: i % 3,
      service: 0,
      status: "completed",
      source: "portal",
      checkin_status: "checked_out",
      arrived_at: iso(new Date(today0.getTime() - (i + 2) * 24 * HOUR + 9.9 * HOUR)),
    });
  for (let i = 0; i < 6; i++)
    addAppt({
      startsAt: new Date(tomorrow0.getTime() + (i + 1) * 24 * HOUR + 11 * HOUR),
      patient: 45 + i,
      doctor: i % DOCTORS.length,
      service: DOCTORS[i % DOCTORS.length].services[0],
      status: i % 2 ? "confirmed" : "awaiting",
      source: "portal",
    });
  await ins(admin, "appointments", appts);
  count("appointments", appts.length);

  // Reminders for tomorrow's bookings: sent, failed and still to come.
  const tomorrowAppts = appts.filter(
    (a) =>
      new Date(a.starts_at) >= tomorrow0 &&
      new Date(a.starts_at) < new Date(tomorrow0.getTime() + 24 * HOUR),
  );
  await ins(
    admin,
    "appointment_reminders",
    tomorrowAppts.map((a, i) => ({
      org_id: org,
      appointment_id: a.id!,
      idx: 2,
      due_at: iso(new Date(new Date(a.starts_at).getTime() - 24 * HOUR)),
      status: i % 5 === 3 ? "failed" : i % 3 === 2 ? "scheduled" : "sent",
      sent_at: i % 5 === 3 || i % 3 === 2 ? null : iso(ago(now, 2)),
      error: i % 5 === 3 ? "WhatsApp error 131026" : null,
    })),
  );

  // ----------------------------------------------------------------------------------- conversations and messages
  const specs = conversationSpecs();
  const { data: cats } = await admin
    .from("conv_categories")
    .insert(["Booking", "Question", "Complaint"].map((name, i) => ({ org_id: org, name, sort: i })))
    .select("id");
  const catIds = (cats ?? []).map((c) => c.id);
  type Msg = Database["public"]["Tables"]["messages"]["Insert"];
  const convRows: Array<Database["public"]["Tables"]["conversations"]["Insert"]> = [];
  const msgRows: Msg[] = [];
  const staffIds = [adminId, receptionistId, financeId].filter((x): x is string => !!x);
  specs.forEach((spec, i) => {
    const contactId = patientIds[24 + (i % 30)];
    const id = randomUUID();
    const lastIn = ago(now, spec.lastInboundHoursAgo);
    const inbound = spec.language === "ar" ? r.pick(DEMO_INBOUND_AR) : r.pick(DEMO_INBOUND_EN);
    const reply = r.pick(DEMO_OUTBOUND_EN);
    const lastAt = spec.lastDirection === "in" ? lastIn : new Date(lastIn.getTime() + 8 * 60_000);
    const assigned =
      spec.state === "open_assigned" || spec.state === "waiting" || spec.state === "failed_send"
        ? staffIds[i % staffIds.length]
        : null;
    convRows.push({
      id,
      org_id: org,
      channel_id: channelId,
      contact_id: contactId,
      status: spec.state === "closed" ? "closed" : spec.state === "waiting" ? "waiting" : "open",
      assignee_user_id: assigned,
      last_inbound_at: iso(lastIn),
      last_outbound_at: spec.lastDirection === "out" ? iso(lastAt) : null,
      last_message_at: iso(lastAt),
      last_message_preview: (spec.lastDirection === "in" ? inbound : reply).slice(0, 80),
      last_message_direction: spec.lastDirection,
      unread_count: spec.unread,
      category_id: spec.state === "closed" ? catIds[i % catIds.length] : null,
      summary: spec.state === "closed" ? "Question answered; no further action." : null,
      opened_at: iso(ago(now, spec.lastInboundHoursAgo + 2)),
      closed_at: spec.state === "closed" ? iso(lastAt) : null,
      closed_by: spec.state === "closed" ? adminId : null,
    });
    const m = (partial: Partial<Msg> & Pick<Msg, "direction" | "kind" | "at">): Msg => ({
      org_id: org,
      conversation_id: id,
      status: partial.direction === "in" ? "received" : "read",
      ...partial,
    });
    msgRows.push(
      m({
        direction: "in",
        kind: "text",
        body: inbound,
        at: iso(new Date(lastIn.getTime() - (spec.lastDirection === "in" ? 0 : 20 * 60_000))),
        wa_message_id: `demo-${slug}-in-${i}`,
      }),
    );
    if (spec.lastDirection === "out" || spec.state === "failed_send") {
      const failed = spec.state === "failed_send";
      msgRows.push(
        m({
          direction: "out",
          kind: "text",
          body: reply,
          at: iso(lastAt),
          status: failed ? "failed" : "read",
          error_code: failed ? (i % 2 ? 131047 : 131026) : null,
          error_message: failed
            ? i % 2
              ? "Re-engagement message: more than 24 hours since the last reply."
              : "Message undeliverable."
            : null,
          wa_message_id: failed ? null : `demo-${slug}-out-${i}`,
          sent_by_user_id: assigned,
        }),
      );
    }
    if (i % 4 === 1)
      msgRows.push(
        m({
          direction: "note",
          kind: "note",
          body: r.pick(DEMO_NOTES),
          at: iso(new Date(lastAt.getTime() + 60_000)),
          sent_by_user_id: assigned ?? adminId,
          status: "received",
        }),
      );
  });
  await ins(admin, "conversations", convRows);
  await ins(admin, "messages", msgRows);
  count("conversations", convRows.length);
  count("messages", msgRows.length);

  // ----------------------------------------------------------------------------------------- enquiry pipelines
  const { data: pipelines } = await admin
    .from("pipelines")
    .insert(PIPELINES.map((p, i) => ({ org_id: org, name: p.name, sort: i, is_default: i === 0 })))
    .select("id, name");
  const stageRows = (pipelines ?? []).flatMap((p) =>
    (PIPELINES.find((x) => x.name === p.name)?.stages ?? []).map((name, sort) => ({
      org_id: org,
      pipeline_id: p.id,
      name,
      sort,
      color: ["gray", "blue", "amber", "green", "purple"][sort % 5],
    })),
  );
  const { data: stages } = await admin
    .from("stages")
    .insert(stageRows)
    .select("id, pipeline_id, name, sort");
  let enquiryCount = 0;
  for (const [pi, p] of (pipelines ?? []).entries()) {
    const own = (stages ?? [])
      .filter((s) => s.pipeline_id === p.id)
      .sort((a, b) => a.sort - b.sort);
    const rows = own.flatMap((stage, si) =>
      [0, 1].map((k) => ({
        org_id: org,
        pipeline_id: p.id,
        stage_id: stage.id,
        status: si === own.length - 1 && k === 1 ? "lost" : si >= 3 && k === 0 ? "won" : "open",
        lost_reason: si === own.length - 1 && k === 1 ? "Chose another clinic" : null,
        closed_at:
          (si === own.length - 1 && k === 1) || (si >= 3 && k === 0) ? iso(ago(now, 20)) : null,
        contact_id: patientIds[(pi * 10 + si * 2 + k) % 60],
        title: `${p.name}: ${["New enquiry", "Callback requested", "Price question"][k % 3]}`,
        source: ["whatsapp", "website", "walk_in"][(si + k) % 3],
        assignee_id: staffIds[(si + k) % staffIds.length],
        created_by: adminId,
      })),
    );
    await ins(admin, "enquiries", rows as never);
    enquiryCount += rows.length;
  }
  count("pipelines", PIPELINES.length);
  count("enquiries", enquiryCount);

  // ------------------------------------------------------------------------------------------------- campaign
  const audienceIds = patientIds.slice(0, 38);
  const { data: segment } = await admin
    .from("segments")
    .insert({
      org_id: org,
      name: "Demo: flu season audience",
      kind: "static",
      member_count: audienceIds.length,
      created_by: adminId,
    })
    .select("id")
    .single();
  await ins(
    admin,
    "segment_members",
    audienceIds.map((id) => ({
      org_id: org,
      segment_id: segment!.id,
      contact_id: id,
      added_by: adminId,
    })),
  );
  const campaignId = randomUUID();
  const started = ago(now, 26);
  await ins(admin, "campaigns", [
    {
      id: campaignId,
      org_id: org,
      name: "Demo: flu season reminder",
      channel_id: channelId,
      template_id: tFlu.id,
      audience_type: "segment",
      segment_id: segment!.id,
      variable_map: { "body.1": "contact.first_name" } as unknown as NonNullable<Json>,
      status: "completed",
      started_at: iso(started),
      completed_at: iso(new Date(started.getTime() + 25 * 60_000)),
      created_by: adminId,
    },
  ]);
  let cursor = 0;
  const recipients: Array<Database["public"]["Tables"]["campaign_recipients"]["Insert"]> = [];
  for (const outcome of CAMPAIGN_OUTCOMES) {
    for (let k = 0; k < outcome.count && cursor < audienceIds.length; k++, cursor++) {
      const sentAt = new Date(started.getTime() + (cursor + 1) * 20_000);
      const reached =
        outcome.status === "read" || outcome.status === "delivered" || outcome.status === "sent";
      recipients.push({
        org_id: org,
        campaign_id: campaignId,
        contact_id: audienceIds[cursor],
        status: outcome.status,
        skip_reason: outcome.status === "skipped" ? "opted_out" : null,
        dispatched_at: outcome.status === "skipped" ? null : iso(sentAt),
        sent_at: reached ? iso(sentAt) : null,
        delivered_at:
          outcome.status === "read" || outcome.status === "delivered"
            ? iso(new Date(sentAt.getTime() + 5_000))
            : null,
        read_at: outcome.status === "read" ? iso(new Date(sentAt.getTime() + 600_000)) : null,
        replied_at:
          outcome.status === "read" && k % 4 === 0
            ? iso(new Date(sentAt.getTime() + 1_800_000))
            : null,
        failed_at: outcome.status === "failed" ? iso(sentAt) : null,
        error_code: outcome.status === "failed" ? (k % 2 ? 131026 : 131050) : null,
        error_message:
          outcome.status === "failed"
            ? k % 2
              ? "Message undeliverable."
              : "User opted out of marketing messages."
            : null,
        attempts: outcome.status === "skipped" ? 0 : 1,
      });
    }
  }
  await ins(admin, "campaign_recipients", recipients);
  const { data: funnel } = await admin.rpc("campaign_funnel", { p_campaign_id: campaignId });
  await admin
    .from("campaigns")
    .update({ stats: (funnel ?? {}) as unknown as NonNullable<Json>, stats_refreshed_at: iso(now) })
    .eq("id", campaignId);
  count("campaign_recipients", recipients.length);

  // --------------------------------------------------------------------------------- recall programme (test mode)
  const programmeId = randomUUID();
  await ins(admin, "recall_programmes", [
    {
      id: programmeId,
      org_id: org,
      key: "birthday",
      name: "Birthday greetings (demo, test mode)",
      kind: "birthday",
      status: "active",
      send_mode_override: "test",
      requires_marketing_opt_in: true,
      max_per_run: 20,
    },
  ] as never);
  const { data: progTemplate } = await admin
    .from("recall_programme_templates")
    .insert({
      org_id: org,
      programme_id: programmeId,
      segment_key: "*",
      wa_template_id: tBirthday.id,
      variables_map: { "1": "contact.first_name" },
    })
    .select("id")
    .single();
  await ins(
    admin,
    "recall_sends",
    patientIds.slice(0, 8).map((contactId, i) => ({
      org_id: org,
      programme_id: programmeId,
      contact_id: contactId,
      cycle_key: String(now.getUTCFullYear()),
      template_id: progTemplate!.id,
      send_mode: "test",
      status: (
        ["sent", "delivered", "read", "read", "delivered", "sent", "failed", "read"] as const
      )[i],
      eligible_at: iso(ago(now, 30 + i)),
      sent_at: iso(ago(now, 29 + i)),
      sent_to_phone_e164: demoPhone(900), // a test number, never the patient's
      replied_at: i === 3 ? iso(ago(now, 20)) : null,
    })) as never,
  );
  count("recall_sends", 8);

  // ------------------------------------------------------------------------- waiting list, notes and tasks
  await ins(admin, "waitlist_entries", [
    {
      org_id: org,
      contact_id: patientIds[50],
      specialist_id: doctorIds[0],
      created_by: deskUser,
      created_at: iso(ago(now, 70)),
    },
    {
      org_id: org,
      contact_id: patientIds[51],
      specialist_id: doctorIds[0],
      service_id: serviceIds[0],
      created_by: deskUser,
      created_at: iso(ago(now, 48)),
    },
    {
      org_id: org,
      contact_id: patientIds[52],
      service_id: serviceIds[4],
      notes: "Prefers mornings.",
      created_by: deskUser,
      created_at: iso(ago(now, 24)),
    },
  ]);
  await ins(admin, "handover_notes", [
    {
      org_id: org,
      body: "Printer on the front desk is out of paper: spare in the cupboard.",
      pinned: true,
      created_by: deskUser,
    },
    {
      org_id: org,
      body: "Dr Bravo is running about 15 minutes behind this afternoon.",
      created_by: deskUser,
    },
  ]);
  await ins(admin, "tasks", [
    {
      org_id: org,
      type: "call",
      subject: "Call patient about test results",
      due_at: iso(ago(now, 2)),
      assignee_id: deskUser,
      contact_id: patientIds[22],
      created_by: adminId,
    },
    {
      org_id: org,
      type: "call",
      subject: "Call patient: reminder not delivered",
      due_at: iso(new Date(now.getTime() + HOUR)),
      assignee_id: deskUser,
      contact_id: patientIds[23],
      created_by: adminId,
    },
    {
      org_id: org,
      type: "follow_up",
      subject: "Follow up on price question",
      due_at: iso(new Date(now.getTime() + 5 * HOUR)),
      assignee_id: adminId,
      contact_id: patientIds[24],
      created_by: adminId,
    },
    {
      org_id: org,
      type: "other",
      subject: "Order new consent forms",
      due_at: iso(new Date(now.getTime() + 30 * HOUR)),
      assignee_id: adminId,
      created_by: adminId,
    },
  ]);
  count("waitlist_entries", 3);
  count("tasks", 4);

  // ------------------------------------------------------------------------------------------------- finance
  const fixture = demoFinanceBatch(now) as { Data?: unknown[] };
  await admin.rpc("seed_finance_reference", { p_org_id: org });
  const batchId = randomUUID();
  const records = Array.isArray(fixture.Data) ? fixture.Data : [];
  await ins(admin, "fin_raw_unite_batches", [
    {
      id: batchId,
      org_id: org,
      requested_at: iso(ago(now, 6)),
      from_date: iso(ago(now, 24 * 30)).slice(0, 10),
      to_date: iso(now).slice(0, 10),
      count_requested: 50,
      record_count: records.length,
      payload: fixture as unknown as NonNullable<Json>,
    },
  ] as never);
  const deps: ProcessDeps = {
    loadBatch: async (id) => {
      const { data } = await admin
        .from("fin_raw_unite_batches")
        .select("id, org_id, payload, record_count")
        .eq("id", id)
        .maybeSingle();
      return data
        ? { id: data.id, orgId: data.org_id, payload: data.payload, recordCount: data.record_count }
        : null;
    },
    apply: async (orgId, batch, invoices, duplicates) => {
      const { data, error } = await admin.rpc("fin_apply_invoices", {
        p_org_id: orgId,
        p_batch_id: batch,
        p_invoices: invoices as unknown as Json,
        p_duplicates: duplicates,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, number>;
    },
    markFailed: async (batch, error) => {
      await admin.rpc("fin_batch_mark_failed", { p_batch_id: batch, p_error: error });
    },
  };
  const processed = await processBatch(deps, batchId);
  if (!processed.ok)
    throw new Error(`demo seed: the finance fixture did not process (${processed.error})`);
  count(
    "finance_invoices",
    processed.counts.invoices_new ?? processed.counts.new ?? records.length,
  );

  // --------------------------------------------------------------------------------------- org settings last
  const { data: orgRow } = await admin.from("orgs").select("settings").eq("id", org).single();
  const base = (orgRow?.settings ?? {}) as Record<string, unknown>;
  await admin
    .from("orgs")
    .update({
      settings: {
        ...base,
        appointments: {
          ...((base.appointments as Record<string, unknown>) ?? {}),
          channel_id: channelId,
          templates: {
            reminder: tReminder.id,
            confirmed: null,
            cancelled: null,
            rescheduled: null,
          },
        },
        front_desk: {
          offers_enabled: true,
          offer_template_id: tOffer.id,
          offer_ttl_minutes: 15,
          offer_batch_size: 1,
          offer_min_lead_minutes: 30,
          registration_message_en: "Hello, I would like to register as a new patient.",
          registration_message_ar: "مرحبا، أود التسجيل كمريض جديد.",
        },
      } as unknown as NonNullable<Json>,
    })
    .eq("id", org);

  return counts;
}
