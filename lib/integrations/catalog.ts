/**
 * The integration catalogue (pure): which integrations exist, who may see and switch them, what they need to run, and the fields
 * their settings form asks for. The Settings, Integrations hub, the actions that save it and the System health page all read this
 * one list. Phase 19b adds its integrations here (see docs/18_PHASE_19A_NOTES.md, "How to add the next integration").
 *
 * A field marked `secret` is stored encrypted (integration_accounts.config_enc, AES-256-GCM) and is never sent back to the
 * browser; every other field lives in integration_accounts.config and is shown as typed.
 */

export const INTEGRATION_KINDS = ["calendar_ics", "sms", "payments"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export function isIntegrationKind(value: string): value is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(value);
}

export type FieldDef = {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "number" | "select";
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: readonly { value: string; label: string }[];
  /** Max length for text, upper bound for numbers. */
  max?: number;
  min?: number;
  /** Value used when the field is left empty. */
  default?: string | number;
};

export type ProviderDef = {
  id: string;
  label: string;
  fields: readonly FieldDef[];
};

export type IntegrationDef = {
  kind: IntegrationKind;
  title: string;
  description: string;
  /** True when Pulse calls the provider (so call health means something). Calendar feeds are only fetched by calendar apps. */
  outbound: boolean;
  /** True when switching it on lets Pulse text patients. */
  contactsPatients: boolean;
  /** True when switching it on lets Pulse ask a patient for money. */
  movesMoney: boolean;
  /** Typed in full to switch it on (only for integrations that contact patients or take money). */
  confirmWord: string | null;
  /** Permission to open its page and work with it (feeds, test, counters). Switching it on or off always needs integrations.manage. */
  viewPermission: "integrations.manage" | "integrations.calendar";
  providers: readonly ProviderDef[];
  /** Settings shared by every provider of this integration. */
  commonFields: readonly FieldDef[];
  /** What a patient or colleague would see if it were on, in one sentence, for the confirmation dialog. */
  consequence: string;
};

const CURRENCIES = ["AED", "SAR", "USD", "EUR", "GBP", "KWD", "BHD", "OMR", "QAR"] as const;

export const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    kind: "calendar_ics",
    outbound: false,
    title: "Doctor calendar feeds",
    description:
      "A private calendar link per doctor to add to Outlook, Google or Apple Calendar. Read-only: it shows when a doctor is booked and where, never who with.",
    contactsPatients: false,
    movesMoney: false,
    confirmWord: null,
    viewPermission: "integrations.calendar",
    providers: [{ id: "ics", label: "iCalendar (ICS) feed", fields: [] }],
    commonFields: [],
    consequence:
      "Doctors can create private calendar links showing appointment times and the clinic location.",
  },
  {
    kind: "sms",
    outbound: true,
    title: "SMS fallback",
    description:
      "When a WhatsApp reminder cannot be delivered, send a short, generic SMS (clinic name, date, time and a phone number) from your registered sender. Never used for marketing.",
    contactsPatients: true,
    movesMoney: false,
    confirmWord: "ENABLE SMS",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "twilio",
        label: "Twilio-style REST gateway",
        fields: [
          {
            key: "account_sid",
            label: "Account SID",
            type: "text",
            required: true,
            max: 64,
            placeholder: "ACxxxxxxxx…",
          },
          {
            key: "auth_token",
            label: "Auth token",
            type: "password",
            secret: true,
            required: true,
            max: 128,
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "sender",
        label: "Registered sender ID",
        type: "text",
        required: true,
        max: 15,
        help: "The UAE-registered alphanumeric sender (up to 11 letters or digits) or a phone number in international format.",
      },
      {
        key: "clinic_name",
        label: "Clinic name in the SMS",
        type: "text",
        required: true,
        max: 40,
      },
      {
        key: "callback_phone",
        label: "Phone number patients should call",
        type: "text",
        required: true,
        max: 20,
        placeholder: "+971 4 000 0000",
      },
      {
        key: "rate_per_sec",
        label: "Messages per second (this sender)",
        type: "number",
        min: 1,
        max: 20,
        default: 5,
      },
      {
        key: "daily_cap",
        label: "Daily limit (messages)",
        type: "number",
        min: 1,
        max: 5000,
        default: 200,
      },
      {
        key: "segment_price",
        label: "Price per message part (optional)",
        type: "text",
        max: 12,
        help: "Only used to show an estimated spend, for example 0.18.",
      },
    ],
    consequence:
      "Patients whose WhatsApp reminder failed will receive a text message from your sender ID. Each SMS costs money.",
  },
  {
    kind: "payments",
    outbound: true,
    title: "Payment links in WhatsApp",
    description:
      "From a finance invoice, send the patient a payment link in a WhatsApp template message. Pulse records what the gateway reports; it never marks an invoice as paid in Unite.",
    contactsPatients: true,
    movesMoney: true,
    confirmWord: "ENABLE PAYMENTS",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "stripe",
        label: "Stripe (Checkout)",
        fields: [
          {
            key: "secret_key",
            label: "Secret key",
            type: "password",
            secret: true,
            required: true,
            max: 200,
            placeholder: "sk_live_…",
          },
          {
            key: "webhook_secret",
            label: "Webhook signing secret",
            type: "password",
            secret: true,
            required: true,
            max: 200,
            placeholder: "whsec_…",
          },
        ],
      },
      {
        id: "paytabs",
        label: "PayTabs (hosted payment page)",
        fields: [
          { key: "profile_id", label: "Profile ID", type: "text", required: true, max: 20 },
          {
            key: "server_key",
            label: "Server key",
            type: "password",
            secret: true,
            required: true,
            max: 200,
          },
          {
            key: "region_host",
            label: "Region",
            type: "select",
            required: true,
            default: "secure.paytabs.com",
            options: [
              { value: "secure.paytabs.com", label: "UAE (secure.paytabs.com)" },
              { value: "secure-oman.paytabs.com", label: "Oman" },
              { value: "secure-egypt.paytabs.com", label: "Egypt" },
              { value: "secure-jordan.paytabs.com", label: "Jordan" },
              { value: "secure.paytabs.sa", label: "Saudi Arabia" },
              { value: "secure-global.paytabs.com", label: "Global" },
            ],
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "currency",
        label: "Currency",
        type: "select",
        required: true,
        default: "AED",
        options: CURRENCIES.map((c) => ({ value: c, label: c })),
      },
      {
        key: "link_expiry_hours",
        label: "Link expires after (hours)",
        type: "number",
        min: 1,
        max: 24,
        default: 24,
      },
      {
        key: "return_url",
        label: "Page shown after paying (optional)",
        type: "url",
        max: 300,
        help: "Leave empty to use Pulse's plain thank-you page.",
      },
    ],
    consequence:
      "Finance staff can send patients a link to pay an invoice by card. Money moves through your payment gateway account.",
  },
];

export function integrationDef(kind: IntegrationKind): IntegrationDef {
  return INTEGRATIONS.find((i) => i.kind === kind)!;
}

export function providerDef(
  kind: IntegrationKind,
  providerId: string | null | undefined,
): ProviderDef | null {
  const def = integrationDef(kind);
  return (
    def.providers.find((p) => p.id === providerId) ??
    (def.providers.length === 1 ? def.providers[0] : null)
  );
}

export function allFields(
  kind: IntegrationKind,
  providerId: string | null | undefined,
): FieldDef[] {
  const p = providerDef(kind, providerId);
  return [...(p?.fields ?? []), ...integrationDef(kind).commonFields];
}

/** Does this integration need the typed confirmation to be switched on? */
export function needsConfirmation(kind: IntegrationKind): boolean {
  const d = integrationDef(kind);
  return d.contactsPatients || d.movesMoney;
}

export type FieldValues = Record<string, string | number>;

export type FieldResult =
  | { ok: true; secrets: Record<string, string>; config: Record<string, string | number> }
  | { ok: false; error: string };

/**
 * Validates a settings form. `existingSecrets` says which secret fields are already stored: leaving one blank keeps the stored
 * value, so the browser never has to be sent a secret back.
 */
export function validateFields(
  fields: readonly FieldDef[],
  input: Record<string, unknown>,
  existingSecrets: Readonly<Record<string, boolean>> = {},
): FieldResult {
  const secrets: Record<string, string> = {};
  const config: Record<string, string | number> = {};
  for (const f of fields) {
    const raw = input[f.key];
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (f.secret) {
        if (f.required && !existingSecrets[f.key])
          return { ok: false, error: `${f.label} is required.` };
        continue;
      }
      if (f.default !== undefined) {
        config[f.key] = f.default;
        continue;
      }
      if (f.required) return { ok: false, error: `${f.label} is required.` };
      config[f.key] = "";
      continue;
    }
    if (f.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n) || !Number.isInteger(n))
        return { ok: false, error: `${f.label} must be a whole number.` };
      if (f.min !== undefined && n < f.min)
        return { ok: false, error: `${f.label} must be at least ${f.min}.` };
      if (f.max !== undefined && n > f.max)
        return { ok: false, error: `${f.label} must be at most ${f.max}.` };
      config[f.key] = n;
      continue;
    }
    if (f.max !== undefined && text.length > f.max)
      return { ok: false, error: `${f.label} is too long.` };
    if (f.type === "url") {
      let u: URL;
      try {
        u = new URL(text);
      } catch {
        return { ok: false, error: `${f.label} must be a web address.` };
      }
      if (u.protocol !== "https:" || u.username || u.password)
        return { ok: false, error: `${f.label} must be an https address.` };
    }
    if (f.type === "select" && !f.options?.some((o) => o.value === text))
      return { ok: false, error: `${f.label} has an unknown value.` };
    if (/[\u0000-\u001f]/.test(text))
      return { ok: false, error: `${f.label} has invalid characters.` };
    if (f.secret) secrets[f.key] = text;
    else config[f.key] = text;
  }
  return { ok: true, secrets, config };
}
