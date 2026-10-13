/**
 * Visit mode and room lifetime rules (pure).
 *
 * A booking is a video visit when the appointment says so, otherwise when its service does. A room is valid from shortly before the
 * visit until the booked end plus a grace period; it is replaced when the booked time moves and revoked when the visit is cancelled,
 * missed or finished.
 */
export type VisitMode = "in_person" | "video";

export function isVisitMode(v: unknown): v is VisitMode {
  return v === "in_person" || v === "video";
}

export function effectiveVisitMode(
  appointment: string | null | undefined,
  service: string | null | undefined,
): VisitMode {
  if (isVisitMode(appointment)) return appointment;
  if (isVisitMode(service)) return service;
  return "in_person";
}

export const VISIT_MODE_LABEL: Record<VisitMode, string> = {
  in_person: "In person",
  video: "Video",
};

export function roomWindow(
  startsAt: Date,
  endsAt: Date,
  o: { graceMinutes: number; earlyMinutes: number },
): { notBefore: Date; expiresAt: Date } {
  return {
    notBefore: new Date(startsAt.getTime() - o.earlyMinutes * 60_000),
    expiresAt: new Date(endsAt.getTime() + o.graceMinutes * 60_000),
  };
}

export type RoomFacts = {
  status: string;
  for_starts_at: string;
  for_ends_at: string;
  expires_at: string;
};

/** Is a stored room still the right one for the appointment as it stands now? */
export function roomIsCurrent(
  room: RoomFacts,
  appt: { starts_at: string; ends_at: string },
  now: Date,
): boolean {
  return (
    room.status === "active" &&
    new Date(room.for_starts_at).getTime() === new Date(appt.starts_at).getTime() &&
    new Date(room.for_ends_at).getTime() === new Date(appt.ends_at).getTime() &&
    new Date(room.expires_at).getTime() > now.getTime()
  );
}

/** Statuses after which a video link must not be given out. */
export function linkAllowedFor(status: string): boolean {
  return status === "awaiting" || status === "confirmed" || status === "completed";
}

export const VIDEO_LINK_PENDING_TEXT = "your clinic will send you the video link";
export const IN_PERSON_TEXT = "at the clinic";

/**
 * The value a message template gets for `appointment.video_link`. Never empty (WhatsApp rejects an empty parameter): the link for a
 * video visit that has one, a plain sentence for a video visit without one, and "at the clinic" for everything else.
 */
export function videoLinkValue(mode: VisitMode, url: string | null): string {
  if (mode !== "video") return IN_PERSON_TEXT;
  return url ?? VIDEO_LINK_PENDING_TEXT;
}
