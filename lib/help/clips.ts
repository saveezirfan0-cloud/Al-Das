/**
 * The training clip catalogue (pure). Clips are listed per role from day one; until a video is recorded the
 * Training page shows "Coming soon". When someone records one, an administrator pastes its link under
 * Settings, Training mode (orgs.settings.help.videos), so no deploy is needed to add a video.
 */
import { z } from "zod";

export type Clip = {
  id: string;
  title: string;
  summary: string;
  minutes: number;
  /** Role names (system presets) the clip is meant for; "all" = everyone. */
  roles: readonly string[];
  /** Page path prefixes whose "?" button opens this clip. */
  pages: readonly string[];
};

export const CLIPS: readonly Clip[] = [
  {
    id: "welcome",
    title: "Finding your way around Pulse",
    summary: "The menu, quick search (Ctrl K), notifications and where Help lives.",
    minutes: 3,
    roles: ["all"],
    pages: ["/dashboard", "/notifications", "/help"],
  },
  {
    id: "my-day",
    title: "Your day as a doctor",
    summary: "Today's list, who is waiting, the next patient, your tasks and the follow-up queue.",
    minutes: 3,
    roles: ["Doctor"],
    pages: ["/my-day"],
  },
  {
    id: "staff-rota",
    title: "Staff records, duties and the rota",
    summary:
      "Adding a person, their duties, visa and licence reminders, and planning a week of shifts.",
    minutes: 5,
    roles: ["HR"],
    pages: ["/staff"],
  },
  {
    id: "front-desk-board",
    title: "Running the day from the Today board",
    summary: "Arrivals by time, confirmed and unconfirmed, check-in steps, no-shows and walk-ins.",
    minutes: 6,
    roles: ["Receptionist", "Manager"],
    pages: ["/front-desk"],
  },
  {
    id: "front-desk-actions",
    title: "One-tap actions: book, move, cancel, call, location, running late",
    summary: "What each button on the patient card does and when the 24-hour rule stops a message.",
    minutes: 5,
    roles: ["Receptionist", "Manager"],
    pages: ["/front-desk"],
  },
  {
    id: "waitlist",
    title: "The waiting list and slot offers",
    summary: "Adding a patient, how a cancelled slot is offered, and what first YES wins means.",
    minutes: 4,
    roles: ["Receptionist", "Manager"],
    pages: ["/front-desk"],
  },
  {
    id: "walk-ins-qr",
    title: "Walk-ins and the desk QR code",
    summary: "Registering a patient at the desk, the consent tick, and printing the QR poster.",
    minutes: 4,
    roles: ["Receptionist"],
    pages: ["/front-desk/qr"],
  },
  {
    id: "households",
    title: "Families that share a phone",
    summary:
      "Linking a child to a parent so reminders go to the right number and name the right patient.",
    minutes: 4,
    roles: ["Receptionist", "Manager", "Care coordinator"],
    pages: ["/contacts"],
  },
  {
    id: "end-of-day",
    title: "End of day sheet and shift handover",
    summary:
      "Unconfirmed tomorrow, unanswered chats, open calls, failed messages, and the handover note.",
    minutes: 4,
    roles: ["Receptionist", "Manager"],
    pages: ["/front-desk/end-of-day"],
  },
  {
    id: "inbox",
    title: "The shared inbox",
    summary:
      "Taking a conversation, quick replies with the / key, templates and the 24-hour window.",
    minutes: 7,
    roles: ["Receptionist", "Agent", "Care coordinator", "Manager"],
    pages: ["/inbox"],
  },
  {
    id: "appointments",
    title: "Booking and moving appointments",
    summary: "Finding a free slot, booking, rescheduling, reminders and what the colours mean.",
    minutes: 6,
    roles: ["Receptionist", "Care coordinator", "Manager"],
    pages: ["/appointments"],
  },
  {
    id: "contacts",
    title: "Patients and the patient record",
    summary: "Searching, editing, tags, merging duplicates and consent flags.",
    minutes: 5,
    roles: ["Receptionist", "Agent", "Manager"],
    pages: ["/contacts"],
  },
  {
    id: "media-library",
    title: "The Media Library",
    summary:
      "Uploading, tagging and finding files, and using them in templates, campaigns and chats.",
    minutes: 4,
    roles: ["Marketing", "Manager", "Agent", "Receptionist"],
    pages: ["/media"],
  },
  {
    id: "patient-documents",
    title: "Patient documents and expiring insurance cards",
    summary:
      "Adding a referral, lab report or insurance card, setting an expiry date and who can see it.",
    minutes: 4,
    roles: ["Receptionist", "Care coordinator", "Manager"],
    pages: ["/settings/documents"],
  },
  {
    id: "tasks",
    title: "Tasks and call lists",
    summary: "Creating, assigning and closing tasks, and call tasks created for you.",
    minutes: 3,
    roles: ["Receptionist", "Agent", "Care coordinator", "Manager"],
    pages: ["/tasks"],
  },
  {
    id: "enquiries",
    title: "Enquiries and pipelines",
    summary: "Moving a lead through the stages and turning it into a booking.",
    minutes: 5,
    roles: ["Agent", "Manager"],
    pages: ["/enquiries"],
  },
  {
    id: "campaigns",
    title: "Campaigns and templates",
    summary: "Choosing an audience, previewing the message, sending and reading the results.",
    minutes: 8,
    roles: ["Marketing", "Manager"],
    pages: ["/campaigns", "/templates", "/flows", "/recall"],
  },
  {
    id: "reports",
    title: "Reports and dashboards",
    summary: "Reading the Management dashboard and exporting a report.",
    minutes: 5,
    roles: ["Manager", "CEO", "Medical Director", "Marketing"],
    pages: ["/reports", "/dashboard"],
  },
  {
    id: "finance",
    title: "Finance and insurance",
    summary: "The monthly summary, claims, exceptions and data freshness.",
    minutes: 8,
    roles: ["Finance", "Billing", "Insurance", "CEO"],
    pages: ["/finance"],
  },
  {
    id: "settings",
    title: "Settings for administrators",
    summary: "Users, roles, channels, appointment rules, security and training mode.",
    minutes: 9,
    roles: ["Admin"],
    pages: ["/settings"],
  },
];

export function clipsForRole(roleName: string | null | undefined): Clip[] {
  const role = (roleName ?? "").trim().toLowerCase();
  return CLIPS.filter(
    (c) => c.roles.includes("all") || c.roles.some((r) => r.toLowerCase() === role),
  );
}

/** The clip whose page prefix matches the path most specifically, or null. */
export function clipForPath(pathname: string, roleName?: string | null): Clip | null {
  const matches = CLIPS.filter((c) =>
    c.pages.some((p) => pathname === p || pathname.startsWith(p + "/")),
  );
  if (matches.length === 0) return null;
  const longest = Math.max(
    ...matches.map((c) =>
      Math.max(
        ...c.pages
          .filter((p) => pathname === p || pathname.startsWith(p + "/"))
          .map((p) => p.length),
      ),
    ),
  );
  const best = matches.filter((c) =>
    c.pages.some((p) => p.length === longest && (pathname === p || pathname.startsWith(p + "/"))),
  );
  // Prefer a clip meant for this role among equally specific ones.
  const role = (roleName ?? "").trim().toLowerCase();
  return best.find((c) => c.roles.some((r) => r.toLowerCase() === role)) ?? best[0];
}

/** Only https links are accepted for recorded videos; anything else is dropped. */
export const videoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((u) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use a full https link.");

export const helpSettingsSchema = z.object({
  videos: z.record(z.string(), videoUrlSchema).default({}),
});
export type HelpSettings = z.infer<typeof helpSettingsSchema>;

/** orgs.settings.help, tolerant: bad entries are dropped, unknown clip ids ignored. */
export function readHelpSettings(orgSettings: unknown): HelpSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).help
      : undefined;
  const videosRaw =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).videos
      : undefined;
  const known = new Set(CLIPS.map((c) => c.id));
  const videos: Record<string, string> = {};
  if (videosRaw && typeof videosRaw === "object" && !Array.isArray(videosRaw)) {
    for (const [id, url] of Object.entries(videosRaw as Record<string, unknown>)) {
      const ok = known.has(id) ? videoUrlSchema.safeParse(url) : null;
      if (ok?.success) videos[id] = ok.data;
    }
  }
  return { videos };
}

export function writeHelpSettings(
  orgSettings: unknown,
  next: HelpSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.help = next;
  return base;
}

export type ClipStatus = { clip: Clip; url: string | null };

/** Every clip with its recorded link (null = "Coming soon"). */
export function clipStatuses(
  clips: readonly Clip[],
  videos: Readonly<Record<string, string>>,
): ClipStatus[] {
  return clips.map((clip) => ({ clip, url: videos[clip.id] ?? null }));
}
