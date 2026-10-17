/**
 * The integration catalogue (pure): which integrations exist, who may see and switch them, what they need to run, and the fields
 * their settings form asks for. The Settings, Integrations hub, the actions that save it and the System health page all read this
 * one list. Phase 19b adds its integrations here (see docs/18_PHASE_19A_NOTES.md, "How to add the next integration").
 *
 * A field marked `secret` is stored encrypted (integration_accounts.config_enc, AES-256-GCM) and is never sent back to the
 * browser; every other field lives in integration_accounts.config and is shown as typed.
 */

export const INTEGRATION_KINDS = [
  "calendar_ics",
  "sms",
  "payments",
  "google_reviews",
  "meta_capi",
  "meta_ads",
  "telehealth",
  "esign",
  "web_chat",
  "instagram",
  "messenger",
  "google_calendar",
  "finance_mailbox",
  "document_seal",
  "tally_bridge",
  "wa_mm_lite",
] as const;
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
  /** A regular expression (source, without slashes) a text value must match, and the sentence shown when it does not. */
  pattern?: string;
  patternHint?: string;
  /** The value can be filled from a file the person chooses (read in the browser as base64); `accept` lists the extensions. */
  upload?: { accept: string };
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
  /** True when switching it on sends patient-derived data to a third party (hashed ad identifiers, a signer's name and e-mail). */
  sharesData: boolean;
  /** True when switching it on lets people outside the clinic put files into Pulse (the finance mailbox). */
  acceptsFiles?: boolean;
  /** True when switching it on makes Pulse sign documents in the organisation's name (the organisation seal). */
  signsDocuments?: boolean;
  /** True when switching it on lets Pulse write into the clinic's accounting books outside Pulse (the Tally bridge). */
  writesBooks?: boolean;
  /** Typed in full to switch it on (only for integrations that contact patients, take money, share patient data, accept files, sign in the organisation's name or write into the accounting books). */
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
    sharesData: false,
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
    sharesData: false,
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
      {
        // Phase 20h (docs/30): any gateway that takes one https POST. Shapes are the administrator's; nothing is verified live.
        id: "http",
        label: "Other gateway (generic HTTP)",
        fields: [
          {
            key: "http_url",
            label: "Gateway address",
            type: "url",
            required: true,
            max: 300,
            placeholder: "https://api.example-gateway.com/v1/sms",
            help: "The https address Pulse posts each SMS to. Only this host is ever called; no query string (put the key in the token field).",
          },
          {
            key: "http_auth",
            label: "Sign-in",
            type: "select",
            required: true,
            default: "bearer",
            options: [
              { value: "bearer", label: "Bearer token (Authorization: Bearer ...)" },
              { value: "basic", label: "User name and password (HTTP Basic)" },
            ],
          },
          {
            key: "http_username",
            label: "User name (Basic sign-in only)",
            type: "text",
            max: 100,
          },
          {
            key: "gateway_secret",
            label: "Token or password",
            type: "password",
            secret: true,
            required: true,
            max: 400,
            help: "The bearer token, or the password for Basic sign-in. Stored encrypted; never shown again.",
          },
          {
            key: "http_encoding",
            label: "Body format",
            type: "select",
            required: true,
            default: "json",
            options: [
              { value: "json", label: "JSON" },
              { value: "form", label: "Form (application/x-www-form-urlencoded)" },
            ],
          },
          {
            key: "http_body",
            label: "Body fields",
            type: "text",
            required: true,
            max: 400,
            placeholder: "to={to}&sender={from}&message={text}",
            help: "name=value pairs separated by &. Use {to} (the number, +971...) and {text} once each, {from} for the sender ID; other values are fixed words. Never put a key here.",
          },
          {
            key: "http_id_field",
            label: "Message id field in the answer (optional)",
            type: "text",
            max: 120,
            placeholder: "id or data.message_id",
            help: "When set, an answer without this field counts as not confirmed and is never sent again.",
          },
          {
            key: "http_test_url",
            label: "Check address for Test connection (optional)",
            type: "url",
            max: 300,
            help: "A read-only address on the same host, such as the account balance. Without it there is no test: a test send would text someone.",
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
    sharesData: false,
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
  {
    kind: "google_reviews",
    outbound: false,
    title: "Google review requests",
    description:
      "After a completed visit, send ONE approved WhatsApp message with your clinic's Google review link. No Google account is connected and no Google service is called: it is only a link inside a template. Only patients who opted in to messages are asked, and nobody is left out because of how their visit went.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: false,
    confirmWord: "ENABLE REVIEW REQUESTS",
    viewPermission: "integrations.manage",
    providers: [{ id: "link", label: "Review link in a WhatsApp template", fields: [] }],
    commonFields: [
      {
        key: "delay_minutes",
        label: "Wait after the visit (minutes)",
        type: "number",
        min: 15,
        max: 4320,
        default: 120,
        help: "The request goes out this long after the visit ended, but only inside the sending hours below.",
      },
      {
        key: "send_from",
        label: "Earliest time of day to send",
        type: "text",
        max: 5,
        default: "09:00",
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        patternHint: "Use 24-hour time such as 09:00.",
        help: "In the clinic's time zone.",
      },
      {
        key: "send_to",
        label: "Latest time of day to send",
        type: "text",
        max: 5,
        default: "20:00",
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        patternHint: "Use 24-hour time such as 20:00.",
      },
      {
        key: "cap_days",
        label: "Ask the same person at most once every (days)",
        type: "number",
        min: 7,
        max: 730,
        default: 90,
        help: "A parent with several children counts as one person.",
      },
    ],
    consequence:
      "Patients who opted in to messages will receive one WhatsApp message with your Google review link after a completed visit (at most once per person in the period you set). Staff can mark a patient 'do not ask'.",
  },
  {
    kind: "meta_capi",
    outbound: true,
    title: "Meta ad attribution",
    description:
      "Records which Meta (Facebook or Instagram) ad each WhatsApp conversation came from, for a report of conversations, enquiries and bookings per ad. In 'send events' mode it also tells Meta when an ad patient made contact, became an enquiry or booked, so Meta can optimise your ads. Only event names and a hashed identifier are sent: never a service, doctor, diagnosis, price or message.",
    contactsPatients: false,
    movesMoney: false,
    sharesData: true,
    confirmWord: "SEND AD EVENTS TO META",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "meta_capi",
        label: "Meta Conversions API (business messaging)",
        fields: [
          {
            key: "dataset_id",
            label: "Dataset ID",
            type: "text",
            max: 30,
            pattern: "^\\d{5,25}$",
            patternHint: "The dataset ID is a number from Meta Events Manager.",
            help: "Only needed to send events. Events Manager, Data sources, your WhatsApp dataset.",
          },
          {
            key: "access_token",
            label: "Access token",
            type: "password",
            secret: true,
            max: 400,
            help: "A system user token with access to that dataset. Stored encrypted; never shown again.",
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "mode",
        label: "What to do",
        type: "select",
        required: true,
        default: "report_only",
        options: [
          {
            value: "report_only",
            label: "Report only: record which ad each conversation came from, send nothing",
          },
          { value: "send_events", label: "Report and send events to Meta" },
        ],
      },
      {
        key: "window_days",
        label: "Attribution window (days after the click)",
        type: "number",
        min: 1,
        max: 28,
        default: 7,
        help: "A booking or enquiry counts for an ad only this many days after the click.",
      },
      {
        key: "include_phone",
        label: "Also send a hashed phone number",
        type: "select",
        default: "no",
        options: [
          { value: "no", label: "No (the click id is enough)" },
          { value: "yes", label: "Yes (SHA-256 of the number, to help Meta match)" },
        ],
      },
      {
        key: "graph_version",
        label: "Graph API version (optional)",
        type: "text",
        max: 8,
        pattern: "^v\\d{1,2}\\.\\d$",
        patternHint: "Use a version such as v21.0, or leave it empty.",
        help: "Leave empty to use the platform's default version.",
      },
      {
        key: "test_event_code",
        label: "Test event code (optional)",
        type: "text",
        max: 40,
        help: "From Events Manager, Test events. While set, Meta shows the events in its test view and does not use them for ads. Clear it for real use.",
      },
    ],
    consequence:
      "Pulse will keep a record of which Meta ad each WhatsApp conversation came from. In 'send events' mode it also sends Meta the event name (Contact, Lead or Schedule), the ad click id and, if you choose, a hashed phone number, only for patients who opted in (or under the basis your administrator confirms). Meta's rules for health advertisers apply to you.",
  },
  {
    // Phase 20i (G13): a read-only daily pull of Meta's own per-ad figures. Nothing about a patient is sent anywhere, so no typed words.
    kind: "meta_ads",
    outbound: true,
    title: "Meta ads spend",
    description:
      "Once a day, reads what each Meta (Facebook or Instagram) ad cost, how often it was shown and clicked, from your ad account, so the Ad attribution report can show cost per conversation, per enquiry and per booking. Read only: Pulse sends Meta nothing about patients and never changes your ads.",
    contactsPatients: false,
    movesMoney: false,
    sharesData: false,
    confirmWord: null,
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "meta_ads",
        label: "Meta Marketing API (ad insights, read only)",
        fields: [
          {
            key: "ad_account_id",
            label: "Ad account ID",
            type: "text",
            required: true,
            max: 30,
            pattern: "^(act_)?\\d{5,25}$",
            patternHint:
              "The ad account ID is a number from Meta Ads Manager (with or without act_).",
            help: "Ads Manager, account menu: the number shown next to the ad account name.",
          },
          {
            key: "access_token",
            label: "Access token",
            type: "password",
            secret: true,
            required: true,
            max: 400,
            help: "A system user token with only the ads_read permission on that ad account. Stored encrypted; never shown again.",
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "lookback_days",
        label: "Days to read each time",
        type: "number",
        min: 1,
        max: 28,
        default: 7,
        help: "Each daily pull reads this many past days again and replaces them, so late corrections from Meta are picked up.",
      },
      graphVersionField(),
    ],
    consequence:
      "Once a day Pulse will read spend, impressions and clicks per ad from this Meta ad account and show them on the Ad attribution report. It only reads: nothing about patients is sent to Meta and your ads are never changed.",
  },
  {
    kind: "telehealth",
    outbound: true,
    title: "Video visits",
    description:
      "Give video appointments a private video link. Staff see a Join button on the appointment and the front desk, and reminders can carry the link. Each appointment gets its own unguessable room that stops working after the visit; nothing is recorded and no patient detail is sent to the video service.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: false,
    confirmWord: "ENABLE VIDEO VISITS",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "static",
        label: "My own meeting service (address template)",
        fields: [
          {
            key: "url_template",
            label: "Meeting address",
            type: "url",
            required: true,
            max: 300,
            placeholder: "https://meet.example.com/{token}",
            pattern: "\\{token\\}",
            patternHint:
              "The address must contain {token} once, for example https://meet.example.com/{token}.",
            help: "{token} is replaced by a different long random value for every appointment. Pulse cannot end such a room: it only stops giving the address out after the visit.",
          },
        ],
      },
      {
        id: "daily",
        label: "Daily.co-style rooms (created through the API)",
        fields: [
          {
            key: "api_key",
            label: "API key",
            type: "password",
            secret: true,
            required: true,
            max: 200,
          },
          {
            key: "domain",
            label: "Domain name",
            type: "text",
            required: true,
            max: 41,
            pattern: "^[a-z0-9][a-z0-9-]{1,40}$",
            patternHint: "Use the part before .daily.co, in lower case.",
            placeholder: "myclinic",
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "grace_minutes",
        label: "Keep the room open after the booked end (minutes)",
        type: "number",
        min: 0,
        max: 240,
        default: 30,
      },
      {
        key: "early_minutes",
        label: "Open the room before the start (minutes)",
        type: "number",
        min: 0,
        max: 240,
        default: 60,
        help: "Only enforced by providers that can (the API option). A reminder sent earlier than this shows a link that is not open yet.",
      },
    ],
    consequence:
      "Video appointments will get a private video link that staff can open and that reminders can carry. Patients will receive these links in WhatsApp messages.",
  },
  {
    kind: "esign",
    outbound: true,
    title: "E-signature for consent forms",
    description:
      "Send a patient's consent form (a PDF) to an e-signature service. The signer receives an e-mail from the service, signs, and the signed copy is stored on the patient as a new consent document. Needs patient documents to be switched on.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: true,
    confirmWord: "SHARE SIGNER DETAILS AND FORMS",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "dropbox_sign",
        label: "Dropbox Sign (HelloSign)",
        fields: [
          {
            key: "api_key",
            label: "API key",
            type: "password",
            secret: true,
            required: true,
            max: 200,
            help: "Also used to check the provider's callbacks. Stored encrypted; never shown again.",
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "test_mode",
        label: "Test mode",
        type: "select",
        required: true,
        default: "yes",
        options: [
          { value: "yes", label: "Yes: free test requests that are not legally binding" },
          { value: "no", label: "No: real, binding signature requests" },
        ],
        help: "Leave on until you have sent yourself a request and seen the signed copy arrive.",
      },
      {
        key: "expiry_days",
        label: "A request expires after (days)",
        type: "number",
        min: 1,
        max: 30,
        default: 7,
      },
    ],
    consequence:
      "This sends patient data to a third party. For every request the e-signature service receives the form itself and the signer's name and e-mail address, and it keeps its own copy of the signed document under its own terms and retention. Make sure your agreement with the service and its data location are approved. The title and message sent are fixed and generic.",
  },
  {
    kind: "web_chat",
    outbound: false,
    title: "Website chat",
    description:
      "A small chat button for your own website. Visitors' messages arrive in the inbox like WhatsApp chats and your replies appear in their browser. Only the websites you list can use it; visitors are identified by a random code kept in their browser, never by a cookie.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: false,
    confirmWord: "ENABLE WEBSITE CHAT",
    viewPermission: "integrations.manage",
    providers: [{ id: "widget", label: "Pulse chat widget", fields: [] }],
    commonFields: [
      {
        key: "allowed_domains",
        label: "Allowed websites",
        type: "text",
        required: true,
        max: 500,
        placeholder: "www.example.com, booking.example.com",
        help: "Host names separated by commas (https only). *.example.com allows every sub-domain. The chat refuses every other website.",
      },
      { key: "title", label: "Title", type: "text", max: 40, default: "Chat with us" },
      {
        key: "colour",
        label: "Colour",
        type: "text",
        max: 7,
        default: "#0f766e",
        pattern: "^#[0-9a-fA-F]{6}$",
        patternHint: "Use a colour such as #0f766e.",
      },
      {
        key: "welcome",
        label: "Welcome text",
        type: "text",
        max: 300,
        default:
          "Hello! How can we help you today? Please do not share medical emergencies here: call your local emergency number.",
      },
    ],
    consequence:
      "Anyone on the websites you list can start a chat. Their messages create patient records without a phone number and appear in the inbox; staff replies are shown in the visitor's browser.",
  },
  {
    kind: "instagram",
    outbound: true,
    title: "Instagram messages",
    description:
      "Answer Instagram direct messages from the inbox. Each person is matched by the id Instagram gives them (never a phone number). Replies are text only and only within 24 hours of the person's last message, as Meta requires.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: false,
    confirmWord: "ENABLE INSTAGRAM MESSAGES",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "meta",
        label: "Meta Messenger Platform (Instagram)",
        fields: [
          {
            key: "page_id",
            label: "Facebook Page ID",
            type: "text",
            required: true,
            max: 25,
            pattern: "^\\d{5,25}$",
            patternHint: "The Page ID is a number.",
            help: "The Page linked to your Instagram professional account. Replies are sent through it.",
          },
          {
            key: "ig_account_id",
            label: "Instagram account ID",
            type: "text",
            required: true,
            max: 25,
            pattern: "^\\d{5,25}$",
            patternHint: "The Instagram professional account ID is a number.",
            help: "Meta puts this id on every message sent to your account; messages for any other account are ignored.",
          },
          ...metaSecretFields(),
        ],
      },
    ],
    commonFields: [graphVersionField()],
    consequence:
      "Instagram direct messages to your account will appear in the inbox and staff replies will be sent from it. Messages pass through Meta under Meta's terms.",
  },
  {
    kind: "messenger",
    outbound: true,
    title: "Facebook Messenger",
    description:
      "Answer Messenger conversations with your Facebook Page from the inbox. Each person is matched by the id Messenger gives them (never a phone number). Replies are text only and only within 24 hours of the person's last message, as Meta requires.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: false,
    confirmWord: "ENABLE MESSENGER MESSAGES",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "meta",
        label: "Meta Messenger Platform",
        fields: [
          {
            key: "page_id",
            label: "Facebook Page ID",
            type: "text",
            required: true,
            max: 25,
            pattern: "^\\d{5,25}$",
            patternHint: "The Page ID is a number.",
            help: "The Page whose Messenger inbox Pulse answers.",
          },
          ...metaSecretFields(),
        ],
      },
    ],
    commonFields: [graphVersionField()],
    consequence:
      "Messenger conversations with your Page will appear in the inbox and staff replies will be sent from it. Messages pass through Meta under Meta's terms.",
  },
  {
    kind: "google_calendar",
    outbound: true,
    title: "Google Calendar sync",
    description:
      "Connect a doctor's Google Calendar. Their busy times come into Pulse so nobody books them then, and their Pulse appointments appear in Google as 'Busy', with no patient name or detail.",
    contactsPatients: false,
    movesMoney: false,
    sharesData: true,
    confirmWord: "SYNC CALENDARS WITH GOOGLE",
    viewPermission: "integrations.calendar",
    providers: [
      {
        id: "google",
        label: "Google Calendar API (OAuth)",
        fields: [
          {
            key: "client_id",
            label: "OAuth client ID",
            type: "text",
            required: true,
            max: 200,
            pattern: "^[A-Za-z0-9._-]+\\.apps\\.googleusercontent\\.com$",
            patternHint: "The client ID ends in .apps.googleusercontent.com.",
          },
          {
            key: "client_secret",
            label: "OAuth client secret",
            type: "password",
            secret: true,
            required: true,
            max: 200,
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "pull_busy",
        label: "Bring busy times into Pulse",
        type: "select",
        default: "yes",
        options: [
          { value: "yes", label: "Yes: block those times for bookings" },
          { value: "no", label: "No" },
        ],
      },
      {
        key: "push_appointments",
        label: "Show Pulse appointments in Google as 'Busy'",
        type: "select",
        default: "yes",
        options: [
          { value: "yes", label: "Yes (title 'Busy', no patient detail)" },
          { value: "no", label: "No" },
        ],
      },
      {
        key: "window_days",
        label: "Days ahead to sync",
        type: "number",
        min: 7,
        max: 120,
        default: 60,
      },
    ],
    consequence:
      "This shares data with Google. For each connected doctor, Google receives the start and end time of their Pulse appointments as 'Busy' events (no patient, service or note), and Pulse reads the times the doctor is busy in Google (not what the events are). Make sure your agreement with Google and its data location are approved.",
  },
  {
    kind: "finance_mailbox",
    outbound: false,
    title: "Finance mailbox",
    description:
      "Supplier invoices, bank statements and processor reports e-mailed to the accounts mailbox arrive in the Finance inbox. The mail service (Postmark inbound) forwards each message to Pulse; Pulse keeps only the PDF, JPEG, PNG, CSV and Excel attachments from the senders you allow, and nothing else of the message: no body, subject, sender name or file name. Patient reports (Diligence, remittance, lab) must not be sent here.",
    contactsPatients: false,
    movesMoney: false,
    sharesData: false,
    acceptsFiles: true,
    confirmWord: "ACCEPT MAILBOX ATTACHMENTS",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "postmark",
        label: "Postmark inbound webhook",
        fields: [
          {
            key: "webhook_secret",
            label: "Webhook password",
            type: "password",
            secret: true,
            required: true,
            max: 128,
            pattern: "^[A-Za-z0-9_-]{24,128}$",
            patternHint:
              "Use 24 to 128 letters, digits, - or _ (for example from a password generator).",
            help: "Put it in the webhook address you give Postmark (shown below once saved). Stored encrypted; never shown again.",
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "allowed_senders",
        label: "Allowed senders",
        type: "text",
        required: true,
        max: 2000,
        placeholder: "accounts@supplier.example, supplier-two.example",
        help: "E-mail addresses, or whole domains, separated by commas or spaces. Mail from anyone else is dropped (and counted).",
      },
    ],
    consequence:
      "Attachments (PDF, JPEG, PNG, CSV, Excel) e-mailed to the accounts mailbox by the allowed senders will be stored in Pulse as finance documents and appear in the Finance inbox. The rest of each message is discarded. Anyone who can send mail as an allowed sender can put a file there, so nothing is paid without the voucher approvals.",
  },
  {
    kind: "document_seal",
    // Signing happens inside Pulse with the stored certificate: no provider is ever called.
    outbound: false,
    title: "Organisation seal (digital signature)",
    description:
      "Pulse signs the payment voucher approval certificate once a voucher is fully approved, and the month-end close pack once the month is locked, with the organisation's certificate (a PAdES digital signature). Any PDF reader then shows who sealed the file and that it has not been changed since. The signing happens inside Pulse; the certificate and the documents are not sent anywhere.",
    contactsPatients: false,
    movesMoney: false,
    sharesData: false,
    signsDocuments: true,
    confirmWord: "SEAL DOCUMENTS",
    viewPermission: "integrations.manage",
    providers: [
      {
        id: "p12",
        label: "Certificate file (.p12 / .pfx)",
        fields: [
          {
            key: "certificate",
            label: "Certificate file (.p12 / .pfx)",
            type: "password",
            secret: true,
            required: true,
            max: 90000,
            upload: { accept: ".p12,.pfx,application/x-pkcs12" },
            pattern: "^[A-Za-z0-9+/]+={0,2}$",
            patternHint: "Choose the certificate file (.p12 or .pfx) again.",
            help: "The organisation's certificate with its private key, exported as .p12 / .pfx (RSA, 2048 bits or more). The file is read in your browser and stored encrypted; it is never shown again.",
          },
          {
            key: "passphrase",
            label: "Certificate password",
            type: "password",
            secret: true,
            required: true,
            max: 200,
            help: "The password the certificate file was exported with. Stored encrypted.",
          },
        ],
      },
    ],
    commonFields: [
      {
        key: "seal_name",
        label: "Name shown with the seal",
        type: "text",
        required: true,
        max: 120,
        placeholder: "Clinic name (organisation seal)",
      },
      {
        key: "reason",
        label: "Reason shown with the seal",
        type: "text",
        max: 200,
        default: "Approved and recorded in Pulse",
      },
      {
        key: "location",
        label: "Location shown with the seal",
        type: "text",
        max: 120,
        default: "Dubai, United Arab Emirates",
      },
    ],
    consequence:
      "Final approval certificates and locked month-end close packs downloaded from Pulse will carry a digital signature in the organisation's name, made with this certificate, and anyone holding the PDF can check it. Use a certificate issued to the organisation, and switch this off at once if the certificate or its password may have leaked.",
  },
  {
    kind: "tally_bridge",
    // The connector on the Tally PC calls Pulse (outbound HTTPS from the clinic); Pulse never calls out. Its calls to
    // Pulse are recorded in integration_calls under "tally_bridge".
    outbound: false,
    title: "Tally bridge (accounting)",
    description:
      "Keeps TallyPrime in step with Pulse until the ledger start: Pulse's approved items are sent to Tally as vouchers, and what is entered in Tally comes back into Pulse's ledger. A small connector on the Tally PC does the talking: it reaches Tally on that PC only and Pulse over HTTPS only, so Tally is never exposed to the internet. Pair it and choose what to send under Accounting, Setup, Tally bridge. The data stays between the clinic's Tally and Pulse.",
    contactsPatients: false,
    movesMoney: false,
    sharesData: false,
    writesBooks: true,
    confirmWord: "CONNECT TALLY",
    viewPermission: "integrations.manage",
    providers: [{ id: "connector", label: "Pulse Tally connector (on the Tally PC)", fields: [] }],
    commonFields: [
      {
        key: "company",
        label: "Tally company name",
        type: "text",
        required: true,
        max: 120,
        placeholder: "Demo Clinic LLC",
        help: "Exactly as the company is named in TallyPrime (it must be open in Tally for the bridge to work). It is the company of the default entity; give other entities (or the default one) their own under Accounting, Entities and fiscal years.",
      },
    ],
    consequence:
      "Once pushing is also switched on (Accounting, Setup, Tally bridge), Pulse will create vouchers in the clinic's Tally company for the items and dates chosen there, and vouchers entered in Tally will be copied into Pulse's ledger. The connector never deletes or changes anything in Tally that Pulse did not create.",
  },
  {
    kind: "wa_mm_lite",
    // Phase 20h (docs/30): sends go through the existing outbound job and the WhatsApp client with the channel's own token,
    // not through the integration client, so there are no integration_calls rows and no Test connection.
    outbound: false,
    title: "Marketing messages through MM Lite",
    description:
      "Sends the Marketing-category template messages of campaigns through Meta's Marketing Messages Lite API instead of the normal Cloud API endpoint. Everything else (inbox, reminders, utility templates, flows) is unchanged, and opt-outs, training mode and the per-number speed limit still apply. Accept Meta's Marketing Messages Lite terms for the WhatsApp Business Account in Meta Business Manager first.",
    contactsPatients: true,
    movesMoney: false,
    sharesData: false,
    confirmWord: "SEND MARKETING THROUGH MM LITE",
    viewPermission: "integrations.manage",
    providers: [{ id: "meta", label: "Meta Marketing Messages Lite API", fields: [] }],
    commonFields: [],
    consequence:
      "Campaign messages that use a Marketing template will reach patients through Meta's Marketing Messages Lite API. Meta decides delivery and pricing for these messages; if the WhatsApp Business Account is not onboarded to MM Lite, those campaign messages fail until this is switched off.",
  },
];

/** The credentials an Instagram or Messenger integration needs (all three stored encrypted). */
function metaSecretFields(): FieldDef[] {
  return [
    {
      key: "page_access_token",
      label: "Page access token",
      type: "password",
      secret: true,
      required: true,
      max: 600,
      help: "A long-lived Page token with the messaging permission. Stored encrypted; never shown again.",
    },
    {
      key: "app_secret",
      label: "App secret",
      type: "password",
      secret: true,
      required: true,
      max: 200,
      help: "Used to check that each webhook call really comes from Meta.",
    },
    {
      key: "verify_token",
      label: "Webhook verify token",
      type: "password",
      secret: true,
      required: true,
      max: 100,
      help: "Any long random text. Type the same text in the Meta app's webhook settings.",
    },
  ];
}

function graphVersionField(): FieldDef {
  return {
    key: "graph_version",
    label: "Graph API version (optional)",
    type: "text",
    max: 8,
    pattern: "^v\\d{1,2}\\.\\d$",
    patternHint: "Use a version such as v21.0, or leave it empty.",
    help: "Leave empty to use the platform's default version.",
  };
}

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
  return (
    d.contactsPatients ||
    d.movesMoney ||
    d.sharesData ||
    d.acceptsFiles === true ||
    d.signsDocuments === true ||
    d.writesBooks === true
  );
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
    if (f.pattern && !new RegExp(f.pattern).test(text))
      return { ok: false, error: f.patternHint ?? `${f.label} is not valid.` };
    if (f.type === "select" && !f.options?.some((o) => o.value === text))
      return { ok: false, error: `${f.label} has an unknown value.` };
    if (/[\u0000-\u001f]/.test(text))
      return { ok: false, error: `${f.label} has invalid characters.` };
    if (f.secret) secrets[f.key] = text;
    else config[f.key] = text;
  }
  return { ok: true, secrets, config };
}
