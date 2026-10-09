/**
 * Starter gallery (Phase 4): original clinic templates in English and Arabic.
 *
 * Rules (CLAUDE.md 10, 12, 14): original wording; no diagnosis, dosing or results in the text; the
 * only personal data a template may carry is the first name and appointment details. Installed as
 * DRAFTS: a person reviews and submits them. Arabic entries ship `reviewed: false` and the UI says
 * "needs review by a native speaker" until someone marks them reviewed.
 */
import {
  emptyDraft,
  type DraftButton,
  type TemplateCategory,
  type TemplateDraft,
} from "@/lib/whatsapp/template-draft";

export type GalleryLanguage = "en" | "ar";

type Variant = {
  body: string;
  examples: string[];
  footer?: string;
  header?: string;
  buttons?: DraftButton[];
};

type Concept = {
  key: string;
  /** Meta template name (same for both languages; Meta keys templates by name + language). */
  name: string;
  title: string;
  description: string;
  category: TemplateCategory;
  /** "body.1" → source key. */
  variableMap: Record<string, string>;
  en: Variant;
  ar: Variant;
};

const q = (text: string): DraftButton => ({ type: "QUICK_REPLY", text });

const CONCEPTS: Concept[] = [
  {
    key: "appointment_reminder",
    name: "appointment_reminder",
    title: "Appointment reminder",
    description: "Sent before a booked appointment, with confirm / reschedule replies.",
    category: "UTILITY",
    variableMap: {
      "body.1": "contact.first_name",
      "body.2": "appointment.datetime",
      "body.3": "appointment.specialist",
      "body.4": "appointment.location",
    },
    en: {
      body: "Hello {{1}}, this is a reminder of your appointment on {{2}} with {{3}} at {{4}}. Please let us know if the time still suits you.",
      examples: ["Sara", "Monday 10 November, 10:00 AM", "Dr. Noor", "Al Das Clinic"],
      footer: "Al Das Medical",
      buttons: [q("Confirm"), q("Reschedule")],
    },
    ar: {
      body: "مرحباً {{1}}، نذكّرك بموعدك يوم {{2}} مع {{3}} في {{4}}. نرجو إعلامنا إن كان الموعد ما زال مناسباً لك.",
      examples: ["سارة", "الاثنين 10 نوفمبر، 10:00 صباحاً", "د. نور", "عيادة الداس"],
      footer: "الداس الطبية",
      buttons: [q("تأكيد"), q("تغيير الموعد")],
    },
  },
  {
    key: "appointment_confirmation",
    name: "appointment_confirmation",
    title: "Appointment confirmation",
    description: "Sent right after a booking is made.",
    category: "UTILITY",
    variableMap: {
      "body.1": "contact.first_name",
      "body.2": "appointment.datetime",
      "body.3": "appointment.location",
    },
    en: {
      body: "Hello {{1}}, your appointment is booked for {{2}} at {{3}}. Reply here if you need to change it.",
      examples: ["Sara", "Monday 10 November, 10:00 AM", "Al Das Clinic"],
      footer: "Al Das Medical",
    },
    ar: {
      body: "مرحباً {{1}}، تم حجز موعدك يوم {{2}} في {{3}}. راسلنا هنا إذا أردت تغييره.",
      examples: ["سارة", "الاثنين 10 نوفمبر، 10:00 صباحاً", "عيادة الداس"],
      footer: "الداس الطبية",
    },
  },
  {
    key: "appointment_rescheduled",
    name: "appointment_rescheduled",
    title: "Appointment rescheduled",
    description: "Sent when an appointment moves to a new time.",
    category: "UTILITY",
    variableMap: {
      "body.1": "contact.first_name",
      "body.2": "appointment.datetime",
      "body.3": "appointment.location",
    },
    en: {
      body: "Hello {{1}}, your appointment has been moved to {{2}} at {{3}}. We are sorry for any inconvenience.",
      examples: ["Sara", "Tuesday 11 November, 11:30 AM", "Al Das Clinic"],
      footer: "Al Das Medical",
    },
    ar: {
      body: "مرحباً {{1}}، تم نقل موعدك إلى {{2}} في {{3}}. نعتذر عن أي إزعاج.",
      examples: ["سارة", "الثلاثاء 11 نوفمبر، 11:30 صباحاً", "عيادة الداس"],
      footer: "الداس الطبية",
    },
  },
  {
    key: "appointment_cancelled",
    name: "appointment_cancelled",
    title: "Appointment cancelled",
    description: "Sent when an appointment is cancelled, inviting a new booking.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name", "body.2": "appointment.datetime" },
    en: {
      body: "Hello {{1}}, your appointment on {{2}} has been cancelled. Reply here whenever you would like to book a new time.",
      examples: ["Sara", "Monday 10 November, 10:00 AM"],
      footer: "Al Das Medical",
      buttons: [q("Book a new time")],
    },
    ar: {
      body: "مرحباً {{1}}، تم إلغاء موعدك يوم {{2}}. راسلنا هنا متى أردت حجز موعد جديد.",
      examples: ["سارة", "الاثنين 10 نوفمبر، 10:00 صباحاً"],
      footer: "الداس الطبية",
      buttons: [q("حجز موعد جديد")],
    },
  },
  {
    key: "missed_appointment",
    name: "missed_appointment_followup",
    title: "Missed appointment follow-up",
    description: "A gentle message after a no-show, offering to rebook.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name", "body.2": "appointment.date" },
    en: {
      body: "Hello {{1}}, we missed you at your appointment on {{2}}. If you would still like to be seen, reply here and we will find a new time.",
      examples: ["Sara", "Monday 10 November"],
      footer: "Al Das Medical",
      buttons: [q("Rebook")],
    },
    ar: {
      body: "مرحباً {{1}}، افتقدناك في موعدك يوم {{2}}. إذا كنت ما زلت ترغب في زيارتنا، راسلنا هنا وسنجد لك وقتاً جديداً.",
      examples: ["سارة", "الاثنين 10 نوفمبر"],
      footer: "الداس الطبية",
      buttons: [q("إعادة الحجز")],
    },
  },
  {
    key: "post_visit_feedback",
    name: "post_visit_feedback",
    title: "Post-visit feedback",
    description: "Asks how the visit went, with three quick replies.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name", "body.2": "appointment.location" },
    en: {
      body: "Hello {{1}}, thank you for visiting {{2}}. How was your experience with us today?",
      examples: ["Sara", "Al Das Clinic"],
      footer: "Your feedback helps us improve",
      buttons: [q("Very good"), q("Okay"), q("Not good")],
    },
    ar: {
      body: "مرحباً {{1}}، شكراً لزيارتك {{2}}. كيف كانت تجربتك معنا اليوم؟",
      examples: ["سارة", "عيادة الداس"],
      footer: "رأيك يساعدنا على التحسّن",
      buttons: [q("ممتازة"), q("مقبولة"), q("غير جيدة")],
    },
  },
  {
    key: "checkup_recall",
    name: "checkup_recall",
    title: "Routine check-up reminder",
    description:
      "Invites a patient who has not visited for a while to book a check-up. Marketing category.",
    category: "MARKETING",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, it has been a while since your last visit. A routine check-up helps you stay on top of your health. Reply here and we will arrange a time that suits you.",
      examples: ["Sara"],
      footer: "Reply STOP to opt out",
      buttons: [q("Book a check-up")],
    },
    ar: {
      body: "مرحباً {{1}}، مرّ وقت منذ زيارتك الأخيرة. الفحص الدوري يساعدك على متابعة صحتك. راسلنا هنا وسنرتب لك موعداً مناسباً.",
      examples: ["سارة"],
      footer: "للتوقف عن الرسائل أرسل إيقاف",
      buttons: [q("حجز فحص")],
    },
  },
  {
    key: "birthday_greeting",
    name: "birthday_greeting",
    title: "Birthday greeting",
    description: "A warm birthday message. Marketing category.",
    category: "MARKETING",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Happy birthday, {{1}}! Everyone at Al Das Medical wishes you a year of good health and happiness.",
      examples: ["Sara"],
      footer: "Reply STOP to opt out",
    },
    ar: {
      body: "عيد ميلاد سعيد يا {{1}}! يتمنى لك فريق الداس الطبية عاماً مليئاً بالصحة والسعادة.",
      examples: ["سارة"],
      footer: "للتوقف عن الرسائل أرسل إيقاف",
    },
  },
  {
    key: "results_ready",
    name: "results_ready",
    title: "Results ready for collection",
    description: "Tells a patient something is ready without stating any result.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, your documents from Al Das Medical are ready. Please contact us here or visit the reception to receive them.",
      examples: ["Sara"],
      footer: "Al Das Medical",
    },
    ar: {
      body: "مرحباً {{1}}، أوراقك من الداس الطبية جاهزة. تواصل معنا هنا أو زر الاستقبال لاستلامها.",
      examples: ["سارة"],
      footer: "الداس الطبية",
    },
  },
  {
    key: "payment_reminder",
    name: "payment_reminder",
    title: "Payment reminder",
    description: "Reminds about an outstanding balance without stating clinical details.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, our records show a balance is still open on your account. Please contact our billing team here and we will be glad to help.",
      examples: ["Sara"],
      footer: "Al Das Medical",
      buttons: [q("Contact billing")],
    },
    ar: {
      body: "مرحباً {{1}}، تشير سجلاتنا إلى وجود مبلغ مستحق على حسابك. يرجى التواصل مع فريق الحسابات هنا وسنسعد بمساعدتك.",
      examples: ["سارة"],
      footer: "الداس الطبية",
      buttons: [q("التواصل مع الحسابات")],
    },
  },
  {
    key: "welcome",
    name: "welcome_message",
    title: "Welcome",
    description: "First reply to a new enquiry.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, thank you for contacting Al Das Medical. A member of our team will be with you shortly. How can we help?",
      examples: ["Sara"],
      footer: "Al Das Medical",
    },
    ar: {
      body: "مرحباً {{1}}، شكراً لتواصلك مع الداس الطبية. سيكون أحد أفراد فريقنا معك قريباً. كيف يمكننا مساعدتك؟",
      examples: ["سارة"],
      footer: "الداس الطبية",
    },
  },
  {
    key: "clinic_hours",
    name: "clinic_hours_and_location",
    title: "Opening hours and location",
    description: "Answers the most common question, with a link to directions.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, here are our opening hours and location. Tap the button below for directions, or reply here with any question.",
      examples: ["Sara"],
      footer: "Al Das Medical",
      buttons: [{ type: "URL", text: "Get directions", url: "https://example.com/directions" }],
    },
    ar: {
      body: "مرحباً {{1}}، هذه ساعات عملنا وموقعنا. اضغط الزر أدناه للحصول على الاتجاهات، أو راسلنا هنا لأي سؤال.",
      examples: ["سارة"],
      footer: "الداس الطبية",
      buttons: [{ type: "URL", text: "الاتجاهات", url: "https://example.com/directions" }],
    },
  },
  {
    key: "contact_us",
    name: "call_us_back",
    title: "We will call you back",
    description: "Confirms a callback request and gives the clinic line.",
    category: "UTILITY",
    variableMap: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, we received your request and will call you back as soon as we can. If it is urgent, please call us directly using the button below.",
      examples: ["Sara"],
      footer: "Al Das Medical",
      buttons: [{ type: "PHONE_NUMBER", text: "Call the clinic", phone_number: "+97140000000" }],
    },
    ar: {
      body: "مرحباً {{1}}، استلمنا طلبك وسنعاود الاتصال بك في أقرب وقت. إذا كان الأمر عاجلاً فاتصل بنا مباشرة عبر الزر أدناه.",
      examples: ["سارة"],
      footer: "الداس الطبية",
      buttons: [{ type: "PHONE_NUMBER", text: "اتصل بالعيادة", phone_number: "+97140000000" }],
    },
  },
];

export type GalleryEntry = {
  /** Stable id: "<concept>:<language>". */
  key: string;
  conceptKey: string;
  title: string;
  description: string;
  language: GalleryLanguage;
  /** Arabic entries need a native speaker before they are submitted. */
  reviewed: boolean;
  draft: TemplateDraft;
};

function toEntry(c: Concept, language: GalleryLanguage): GalleryEntry {
  const v = c[language];
  return {
    key: `${c.key}:${language}`,
    conceptKey: c.key,
    title: c.title,
    description: c.description,
    language,
    reviewed: language === "en",
    draft: emptyDraft({
      name: c.name,
      language,
      category: c.category,
      kind: v.buttons?.length ? "media_interactive" : "standard",
      header: v.header ? { format: "TEXT", text: v.header } : { format: "NONE" },
      body: v.body,
      bodyExamples: v.examples,
      footer: v.footer ?? "",
      buttons: v.buttons ?? [],
      variableMap: c.variableMap,
    }),
  };
}

/** Every gallery template, English first then Arabic per concept. */
export const GALLERY: GalleryEntry[] = CONCEPTS.flatMap((c) => [
  toEntry(c, "en"),
  toEntry(c, "ar"),
]);

export function galleryEntry(key: string): GalleryEntry | undefined {
  return GALLERY.find((g) => g.key === key);
}

/** A fresh copy of a gallery draft (callers mutate drafts). */
export function cloneGalleryDraft(key: string): TemplateDraft | null {
  const g = galleryEntry(key);
  return g ? (JSON.parse(JSON.stringify(g.draft)) as TemplateDraft) : null;
}
