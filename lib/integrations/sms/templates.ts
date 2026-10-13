import { formatInTimeZone } from "date-fns-tz";

/**
 * The only SMS text Pulse sends (pure). Fixed wording, no free text: the clinic name, the date and time, and the number to call.
 * No patient name, no doctor, no service, no diagnosis. The single exception is a message that goes to a GUARDIAN: it names the
 * child by first name, because a parent with three children cannot tell whose appointment it is otherwise (Phase 14 rule).
 */

export type SmsLanguage = "en" | "ar";

export function chooseSmsLanguage(
  contactLanguage: string | null | undefined,
  fallback: SmsLanguage = "en",
): SmsLanguage {
  const l = (contactLanguage ?? "").trim().toLowerCase();
  if (l.startsWith("ar")) return "ar";
  if (l.startsWith("en")) return "en";
  return fallback;
}

export type ReminderSmsInput = {
  clinicName: string;
  callbackPhone: string;
  startsAt: Date;
  timezone: string;
  language: SmsLanguage;
  /** Set only when the message goes to a guardian. */
  patientFirstName?: string | null;
};

/** Plain text only: no line breaks or control characters can come from a stored name. */
function clean(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function renderReminderSms(i: ReminderSmsInput): string {
  const clinic = clean(i.clinicName, 40);
  const phone = clean(i.callbackPhone, 20);
  const date = formatInTimeZone(i.startsAt, i.timezone, "dd/MM/yyyy");
  const time = formatInTimeZone(i.startsAt, i.timezone, "HH:mm");
  const name = i.patientFirstName ? clean(i.patientFirstName.split(/\s+/)[0] ?? "", 30) : "";
  if (i.language === "ar") {
    const subject = name ? `موعد ${name}` : "موعدكم";
    return `${clinic}: تذكير بـ${subject} يوم ${date} الساعة ${time}. للتغيير يرجى الاتصال على ${phone}`;
  }
  const subject = name ? `${name}'s appointment` : "your appointment";
  return `${clinic}: reminder of ${subject} on ${date} at ${time}. To change it please call ${phone}`;
}
