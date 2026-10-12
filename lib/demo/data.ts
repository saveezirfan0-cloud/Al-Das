/**
 * Synthetic demo content (pure, deterministic). Nothing here comes from a real person: names are obviously fake
 * ("Layla Demo-07"), phone numbers are in the UK Ofcom drama range +44 7700 900000 to 900999 (reserved for fiction),
 * and message texts are generic. The same seed always gives the same workspace.
 */

/** Small seeded generator so a reset is reproducible (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
  };
}

const FIRST_EN = [
  "Layla",
  "Omar",
  "Sara",
  "Yusuf",
  "Mina",
  "Karim",
  "Nadia",
  "Tariq",
  "Huda",
  "Faisal",
  "Amal",
  "Samir",
];
const FIRST_AR = [
  "ليلى",
  "عمر",
  "سارة",
  "يوسف",
  "مينا",
  "كريم",
  "نادية",
  "طارق",
  "هدى",
  "فيصل",
  "أمل",
  "سمير",
];

export type DemoPerson = {
  index: number;
  first: string;
  last: string;
  phone: string | null;
  language: "en" | "ar";
  dob: string;
};

/** The reserved fictional number for person n (0..999). */
export function demoPhone(n: number): string {
  if (n < 0 || n > 999) throw new Error("demo phone out of range");
  return `+447700900${String(n).padStart(3, "0")}`;
}

export function isDemoPhone(phone: string): boolean {
  return /^\+447700900\d{3}$/.test(phone);
}

export function demoPerson(index: number, opts: { withPhone?: boolean } = {}): DemoPerson {
  const language = index % 3 === 2 ? "ar" : "en";
  const pool = language === "ar" ? FIRST_AR : FIRST_EN;
  const born = 1950 + ((index * 7) % 55);
  const month = String(1 + ((index * 5) % 12)).padStart(2, "0");
  const day = String(1 + ((index * 11) % 28)).padStart(2, "0");
  return {
    index,
    first: pool[index % pool.length],
    last: `Demo-${String(index).padStart(2, "0")}`,
    phone: opts.withPhone === false ? null : demoPhone(index + 10),
    language,
    dob: `${born}-${month}-${day}`,
  };
}

export const DEMO_INBOUND_EN = [
  "Hello, do you have any appointments this week?",
  "Hi, I need to change my appointment to another day.",
  "What are your opening hours on Friday?",
  "Can I get my results sent to me?",
  "I would like to book a check-up for my daughter.",
  "Is parking available at the clinic?",
  "Thank you, see you tomorrow.",
  "Please can someone call me back?",
];
export const DEMO_INBOUND_AR = [
  "مرحبا، هل يوجد موعد متاح هذا الأسبوع؟",
  "أريد تغيير موعدي ليوم آخر من فضلكم.",
  "شكرا لكم.",
];
export const DEMO_OUTBOUND_EN = [
  "Hello, thank you for contacting us. How can we help?",
  "Of course. We have a slot tomorrow morning. Would that suit you?",
  "You are booked in. We look forward to seeing you.",
  "We are open 9 am to 5 pm, Monday to Saturday.",
];
export const DEMO_NOTES = [
  "Patient prefers morning slots.",
  "Checked the diary; first free slot is Thursday.",
  "Waiting for the patient to confirm.",
];

export const DEPARTMENTS = ["General practice", "Dentistry", "Dermatology"] as const;
export const SERVICES = [
  { name: "GP consultation", dept: 0, minutes: 30, price: 250 },
  { name: "Follow-up visit", dept: 0, minutes: 15, price: 150 },
  { name: "Dental check-up", dept: 1, minutes: 30, price: 300 },
  { name: "Scale and polish", dept: 1, minutes: 45, price: 450 },
  { name: "Skin consultation", dept: 2, minutes: 30, price: 350 },
  { name: "Long consultation", dept: 0, minutes: 60, price: 400 },
] as const;
export const DOCTORS = [
  { name: "Dr Alpha Demo", dept: 0, location: 0, services: [0, 1, 5] },
  { name: "Dr Bravo Demo", dept: 0, location: 0, services: [0, 1] },
  { name: "Dr Charlie Demo", dept: 1, location: 0, services: [2, 3] },
  { name: "Dr Delta Demo", dept: 2, location: 1, services: [4] },
  { name: "Dr Echo Demo", dept: 0, location: 1, services: [0, 1, 5] },
] as const;
export const LOCATIONS = [
  {
    name: "Demo Clinic Main",
    address: "1 Example Street, Demo City",
    latitude: 25.2048,
    longitude: 55.2708,
  },
  {
    name: "Demo Clinic Branch",
    address: "2 Sample Road, Demo City",
    latitude: 25.1972,
    longitude: 55.2744,
  },
] as const;

export const PIPELINES = [
  { name: "General practice", stages: ["New", "Contacted", "Booked", "Attended", "Follow-up"] },
  { name: "Dentistry", stages: ["New", "Quote sent", "Booked", "Treated", "Recall"] },
  { name: "Dermatology", stages: ["New", "Photo received", "Booked", "Seen", "Review"] },
] as const;

/** The 30 conversations, each in a different state. Fractions of `now` are applied by the seeder. */
export type ConversationSpec = {
  state:
    | "open_assigned"
    | "open_unassigned_unread"
    | "waiting"
    | "closed"
    | "outside_window"
    | "failed_send";
  /** Hours since the patient's last message. */
  lastInboundHoursAgo: number;
  unread: number;
  /** Who spoke last. */
  lastDirection: "in" | "out";
  language: "en" | "ar";
};

export function conversationSpecs(): ConversationSpec[] {
  const out: ConversationSpec[] = [];
  const add = (n: number, spec: Omit<ConversationSpec, "language">) => {
    for (let i = 0; i < n; i++)
      out.push({
        ...spec,
        lastInboundHoursAgo: spec.lastInboundHoursAgo + i * 0.4,
        language: out.length % 3 === 2 ? "ar" : "en",
      });
  };
  add(8, { state: "open_assigned", lastInboundHoursAgo: 0.5, unread: 0, lastDirection: "out" });
  add(5, {
    state: "open_unassigned_unread",
    lastInboundHoursAgo: 0.2,
    unread: 2,
    lastDirection: "in",
  });
  add(4, { state: "waiting", lastInboundHoursAgo: 5, unread: 0, lastDirection: "out" });
  add(6, { state: "closed", lastInboundHoursAgo: 30, unread: 0, lastDirection: "out" });
  add(4, { state: "outside_window", lastInboundHoursAgo: 72, unread: 1, lastDirection: "in" });
  add(3, { state: "failed_send", lastInboundHoursAgo: 3, unread: 0, lastDirection: "out" });
  return out;
}

/** How a finished campaign's recipients ended up (sums to the audience size). */
export const CAMPAIGN_OUTCOMES = [
  { status: "read", count: 16 },
  { status: "delivered", count: 10 },
  { status: "sent", count: 3 },
  { status: "failed", count: 5 },
  { status: "skipped", count: 4 },
] as const;
