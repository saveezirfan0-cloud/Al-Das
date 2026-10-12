/**
 * One-tap desk messages (pure): the wording of "send location" and "running late", and how each goes out under the
 * 24-hour rule (free text inside the window, the mapped template outside it, refused when there is no template).
 * The text carries no patient data beyond what the patient already knows (the clinic, the doctor, minutes).
 */
import { isArabic } from "@/lib/inbox/quick-reply";

export const LATE_MINUTE_CHOICES = [10, 15, 20, 30, 45, 60] as const;

export function isLateChoice(n: number): n is (typeof LATE_MINUTE_CHOICES)[number] {
  return (LATE_MINUTE_CHOICES as readonly number[]).includes(n);
}

export function runningLateText(input: {
  minutes: number;
  specialist?: string | null;
  language?: string | null;
}): string {
  const who = input.specialist?.trim();
  if (isArabic(input.language)) {
    return `نعتذر عن التأخير. ${who ? `الدكتور ${who} متأخر` : "الطبيب متأخر"} حوالي ${input.minutes} دقيقة. شكراً لتفهمك.`;
  }
  return `We are sorry for the delay. ${who ? `${who} is` : "Your doctor is"} running about ${input.minutes} minutes late. Thank you for your patience.`;
}

export type LocationInfo = {
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  maps_url: string | null;
};

/** A WhatsApp location pin needs both coordinates; otherwise the address and map link go out as plain text. */
export function locationMessage(
  loc: LocationInfo,
  language?: string | null,
):
  | { kind: "pin"; latitude: number; longitude: number; name: string; address?: string }
  | { kind: "text"; body: string }
  | null {
  if (loc.latitude !== null && loc.longitude !== null) {
    return {
      kind: "pin",
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.name,
      ...(loc.address ? { address: loc.address } : {}),
    };
  }
  const lines = [isArabic(language) ? `موقعنا: ${loc.name}` : `Find us at ${loc.name}`];
  if (loc.address) lines.push(loc.address);
  if (loc.maps_url) lines.push(loc.maps_url);
  return lines.length > 1 ? { kind: "text", body: lines.join("\n") } : null;
}
