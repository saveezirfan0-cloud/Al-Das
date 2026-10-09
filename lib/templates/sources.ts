/**
 * What a template variable can be filled from, at template level (variable_map). The inbox
 * picker, appointment reminders and campaigns each resolve the subset they have data for;
 * campaigns can additionally map to custom fields and CSV columns per campaign.
 */
export const TEMPLATE_SOURCES = [
  { key: "contact.first_name", label: "Contact: first name", group: "Contact", sample: "Sara" },
  { key: "contact.last_name", label: "Contact: last name", group: "Contact", sample: "Khan" },
  { key: "contact.full_name", label: "Contact: full name", group: "Contact", sample: "Sara Khan" },
  {
    key: "appointment.date",
    label: "Appointment: date",
    group: "Appointment",
    sample: "Monday 12 October",
  },
  { key: "appointment.time", label: "Appointment: time", group: "Appointment", sample: "10:30 AM" },
  {
    key: "appointment.datetime",
    label: "Appointment: date and time",
    group: "Appointment",
    sample: "Monday 12 October, 10:30 AM",
  },
  {
    key: "appointment.specialist",
    label: "Appointment: doctor",
    group: "Appointment",
    sample: "Dr. Omar",
  },
  {
    key: "appointment.location",
    label: "Appointment: location",
    group: "Appointment",
    sample: "Main clinic",
  },
  {
    key: "appointment.service",
    label: "Appointment: service",
    group: "Appointment",
    sample: "Consultation",
  },
  { key: "appointment.number", label: "Appointment: number", group: "Appointment", sample: "1042" },
] as const;

const KEYS: ReadonlySet<string> = new Set(TEMPLATE_SOURCES.map((s) => s.key));

/** True for sources a template-level map may hold (including aliases used by earlier phases). */
export function isTemplateSource(value: string): boolean {
  return (
    KEYS.has(value) ||
    value === "contact.name" ||
    value.startsWith("text:") ||
    /^custom\.[a-z0-9_]+$/.test(value)
  );
}

/** A believable example for a source, used to pre-fill the examples Meta requires. */
export function sampleFor(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("text:")) return value.slice(5) || null;
  if (value === "contact.name") return "Sara Khan";
  return TEMPLATE_SOURCES.find((s) => s.key === value)?.sample ?? null;
}
