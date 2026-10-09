/**
 * Starter gallery: original clinic templates in English and Arabic. The copy is deliberately
 * administrative (bookings, reminders, hospitality, billing, light marketing): nothing here
 * gives clinical advice, and clinical recall wording belongs to the signed-off recall
 * programmes (Phase 8). Each entry is a complete draft that passes validateDraft, except
 * where `needsMedia` / `placeholderLink` say the clinic must add a file or replace a link.
 */
import { emptyDraft, type DraftButton, type TemplateDraft } from "@/lib/templates/builder";

export type GalleryUseCase =
  "Appointments" | "Welcome & follow-up" | "Feedback" | "Marketing" | "Billing";

export type GalleryItem = {
  /** Stable id, e.g. "appointment_reminder_ar". */
  key: string;
  title: string;
  description: string;
  useCase: GalleryUseCase;
  language: "en" | "ar";
  /** Clinic must upload a header sample before submitting. */
  needsMedia: boolean;
  /** Contains a placeholder link the clinic must replace. */
  placeholderLink: boolean;
  draft: TemplateDraft;
};

type Copy = {
  body: string;
  examples: string[];
  buttons?: DraftButton[];
  header?: string;
  footer?: string;
};

type Def = {
  key: string;
  title: string;
  description: string;
  useCase: GalleryUseCase;
  category: "MARKETING" | "UTILITY";
  /** body.n → source */
  map: Record<string, string>;
  en: Copy;
  ar: Copy;
  media?: boolean;
};

const STOP_EN = "Reply STOP to unsubscribe";
const STOP_AR = "أرسل STOP لإلغاء الاشتراك";

const APPT_BUTTONS_EN: DraftButton[] = [
  { type: "QUICK_REPLY", text: "Confirm" },
  { type: "QUICK_REPLY", text: "Reschedule" },
  { type: "QUICK_REPLY", text: "Cancel" },
];
// classifyButtonReply (lib/appointments/button-reply.ts) understands these Arabic titles.
const APPT_BUTTONS_AR: DraftButton[] = [
  { type: "QUICK_REPLY", text: "تأكيد" },
  { type: "QUICK_REPLY", text: "تغيير الموعد" },
  { type: "QUICK_REPLY", text: "إلغاء" },
];

const AR_NAME = "سارة";
const AR_DATE = "الاثنين ١٢ أكتوبر";
const AR_TIME = "١٠:٣٠ صباحاً";
const AR_DOCTOR = "د. عمر";

const DEFS: Def[] = [
  {
    key: "appointment_confirmation",
    title: "Appointment confirmation",
    description: "Sent when a booking is made, with Confirm / Reschedule / Cancel buttons.",
    useCase: "Appointments",
    category: "UTILITY",
    map: {
      "body.1": "contact.first_name",
      "body.2": "appointment.date",
      "body.3": "appointment.time",
      "body.4": "appointment.specialist",
    },
    en: {
      body: "Hello {{1}}, your appointment with {{4}} is booked for {{2}} at {{3}}. Please use the buttons below to confirm, change or cancel it.",
      examples: ["Sara", "Monday 12 October", "10:30 AM", "Dr. Omar"],
      buttons: APPT_BUTTONS_EN,
    },
    ar: {
      body: "مرحباً {{1}}، تم حجز موعدك مع {{4}} يوم {{2}} الساعة {{3}}. يرجى استخدام الأزرار أدناه للتأكيد أو التغيير أو الإلغاء.",
      examples: [AR_NAME, AR_DATE, AR_TIME, AR_DOCTOR],
      buttons: APPT_BUTTONS_AR,
    },
  },
  {
    key: "appointment_reminder",
    title: "Appointment reminder",
    description: "The 24-hour reminder, with Confirm / Reschedule / Cancel buttons.",
    useCase: "Appointments",
    category: "UTILITY",
    map: {
      "body.1": "contact.first_name",
      "body.2": "appointment.specialist",
      "body.3": "appointment.date",
      "body.4": "appointment.time",
    },
    en: {
      body: "Hi {{1}}, this is a reminder of your appointment with {{2}} on {{3}} at {{4}}. We look forward to seeing you at the clinic.",
      examples: ["Sara", "Dr. Omar", "Monday 12 October", "10:30 AM"],
      buttons: APPT_BUTTONS_EN,
    },
    ar: {
      body: "مرحباً {{1}}، نذكّرك بموعدك مع {{2}} يوم {{3}} الساعة {{4}}. بانتظارك في العيادة.",
      examples: [AR_NAME, AR_DOCTOR, AR_DATE, AR_TIME],
      buttons: APPT_BUTTONS_AR,
    },
  },
  {
    key: "appointment_rescheduled",
    title: "Appointment rescheduled",
    description: "Tells the patient their appointment moved.",
    useCase: "Appointments",
    category: "UTILITY",
    map: {
      "body.1": "contact.first_name",
      "body.2": "appointment.date",
      "body.3": "appointment.time",
    },
    en: {
      body: "Hello {{1}}, your appointment has been moved to {{2}} at {{3}}. If this time does not suit you, just reply to this message and we will help.",
      examples: ["Sara", "Tuesday 13 October", "11:00 AM"],
    },
    ar: {
      body: "مرحباً {{1}}، تم تغيير موعدك إلى يوم {{2}} الساعة {{3}}. إذا لم يناسبك الوقت، يمكنك الرد على هذه الرسالة وسنساعدك.",
      examples: [AR_NAME, "الثلاثاء ١٣ أكتوبر", "١١:٠٠ صباحاً"],
    },
  },
  {
    key: "appointment_cancelled",
    title: "Appointment cancelled",
    description: "Confirms a cancellation and invites the patient to rebook.",
    useCase: "Appointments",
    category: "UTILITY",
    map: { "body.1": "contact.first_name", "body.2": "appointment.date" },
    en: {
      body: "Hello {{1}}, your appointment on {{2}} has been cancelled as requested. Reply to this message whenever you would like to book a new one.",
      examples: ["Sara", "Monday 12 October"],
    },
    ar: {
      body: "مرحباً {{1}}، تم إلغاء موعدك بتاريخ {{2}} بناءً على طلبك. يمكنك الرد على هذه الرسالة في أي وقت لحجز موعد جديد.",
      examples: [AR_NAME, AR_DATE],
    },
  },
  {
    key: "welcome_message",
    title: "Welcome message",
    description: "First reply to a new enquiry.",
    useCase: "Welcome & follow-up",
    category: "UTILITY",
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, thank you for contacting our clinic. A member of our team will reply shortly. In an emergency, please contact your nearest emergency service.",
      examples: ["Sara"],
    },
    ar: {
      body: "مرحباً {{1}}، شكراً لتواصلك مع عيادتنا. سيرد عليك أحد أعضاء فريقنا قريباً. في الحالات الطارئة يرجى التواصل مع أقرب جهة طوارئ.",
      examples: [AR_NAME],
    },
  },
  {
    key: "we_tried_to_reach_you",
    title: "We tried to reach you",
    description: "Follow-up after an unanswered call or enquiry.",
    useCase: "Welcome & follow-up",
    category: "UTILITY",
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, we tried to reach you about your recent enquiry. Reply to this message and we will get back to you at a time that suits you.",
      examples: ["Sara"],
    },
    ar: {
      body: "مرحباً {{1}}، حاولنا التواصل معك بخصوص استفسارك الأخير. يمكنك الرد على هذه الرسالة وسنتواصل معك في الوقت المناسب لك.",
      examples: [AR_NAME],
    },
  },
  {
    key: "opening_hours_update",
    title: "Opening hours change",
    description: "Announces changed opening hours (holidays, Ramadan).",
    useCase: "Welcome & follow-up",
    category: "UTILITY",
    map: {
      "body.1": "contact.first_name",
      "body.2": "text:Friday 16 October",
      "body.3": "text:from 9 AM to 2 PM",
    },
    en: {
      body: "Hello {{1}}, please note that our clinic opening hours will change on {{2}}. We will be open {{3}}. Reply to this message if you need help booking.",
      examples: ["Sara", "Friday 16 October", "from 9 AM to 2 PM"],
    },
    ar: {
      body: "مرحباً {{1}}، نود إعلامك بأن ساعات عمل العيادة ستتغير يوم {{2}}. سنكون متاحين {{3}}. يمكنك الرد على هذه الرسالة إذا احتجت إلى مساعدة في الحجز.",
      examples: [AR_NAME, "الجمعة ١٦ أكتوبر", "من ٩ صباحاً إلى ٢ ظهراً"],
    },
  },
  {
    key: "visit_feedback",
    title: "Visit feedback",
    description: "Asks how the visit went, answered by a free-text reply.",
    useCase: "Feedback",
    category: "UTILITY",
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, thank you for visiting us. We would love to hear how your visit went. Please tell us by replying to this message.",
      examples: ["Sara"],
    },
    ar: {
      body: "مرحباً {{1}}، شكراً لزيارتك لنا. يسعدنا أن نسمع رأيك في زيارتك. يمكنك إخبارنا بالرد على هذه الرسالة.",
      examples: [AR_NAME],
    },
  },
  {
    key: "review_request",
    title: "Review request",
    description:
      "Invites a happy patient to leave a public review. Replace the link before submitting.",
    useCase: "Feedback",
    category: "MARKETING",
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, if you were happy with our service, a short review helps other families find us. Thank you for your support.",
      examples: ["Sara"],
      buttons: [{ type: "URL", text: "Leave a review", url: "https://example.com/review" }],
      footer: STOP_EN,
    },
    ar: {
      body: "مرحباً {{1}}، إذا كنت راضياً عن خدماتنا، فإن تقييمك القصير يساعد الآخرين على الوصول إلينا. شكراً لدعمك.",
      examples: [AR_NAME],
      buttons: [{ type: "URL", text: "اكتب تقييماً", url: "https://example.com/review" }],
      footer: STOP_AR,
    },
  },
  {
    key: "birthday_greeting",
    title: "Birthday greeting",
    description:
      "A warm birthday message (the recall programmes in Phase 8 send it by age and gender band).",
    useCase: "Marketing",
    category: "MARKETING",
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Happy birthday {{1}}! Everyone at our clinic wishes you a healthy and joyful year ahead.",
      examples: ["Sara"],
      footer: STOP_EN,
    },
    ar: {
      body: "عيد ميلاد سعيد يا {{1}}! يتمنى لك جميع العاملين في عيادتنا عاماً مليئاً بالصحة والسعادة.",
      examples: [AR_NAME],
      footer: STOP_AR,
    },
  },
  {
    key: "health_check_offer",
    title: "Health check packages",
    description: "Announces check-up packages and invites a reply to book.",
    useCase: "Marketing",
    category: "MARKETING",
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, our annual health check packages are now available. Reply to this message to learn more or to book a time that suits you.",
      examples: ["Sara"],
      buttons: [{ type: "QUICK_REPLY", text: "Tell me more" }],
      footer: STOP_EN,
    },
    ar: {
      body: "مرحباً {{1}}، باقات الفحص الصحي السنوي لدينا متوفرة الآن. يمكنك الرد على هذه الرسالة لمعرفة المزيد أو لحجز موعد مناسب لك.",
      examples: [AR_NAME],
      buttons: [{ type: "QUICK_REPLY", text: "أخبرني المزيد" }],
      footer: STOP_AR,
    },
  },
  {
    key: "clinic_news_with_image",
    title: "News with an image",
    description:
      "An announcement with a header image and a link. Upload the image and replace the link before submitting.",
    useCase: "Marketing",
    category: "MARKETING",
    media: true,
    map: { "body.1": "contact.first_name" },
    en: {
      body: "Hello {{1}}, we are pleased to share some news from our clinic. Tap the button below to read more.",
      examples: ["Sara"],
      buttons: [{ type: "URL", text: "Read more", url: "https://example.com/news" }],
      footer: STOP_EN,
    },
    ar: {
      body: "مرحباً {{1}}، يسعدنا أن نشارككم أخباراً جديدة من عيادتنا. اضغط على الزر أدناه لقراءة المزيد.",
      examples: [AR_NAME],
      buttons: [{ type: "URL", text: "اقرأ المزيد", url: "https://example.com/news" }],
      footer: STOP_AR,
    },
  },
  {
    key: "invoice_ready",
    title: "Invoice ready",
    description: "Lets the patient know an invoice is ready.",
    useCase: "Billing",
    category: "UTILITY",
    map: { "body.1": "contact.first_name", "body.2": "appointment.number" },
    en: {
      body: "Hello {{1}}, your invoice number {{2}} is ready. Please visit reception or reply to this message if you have any questions about it.",
      examples: ["Sara", "1042"],
    },
    ar: {
      body: "مرحباً {{1}}، فاتورتك رقم {{2}} جاهزة. يرجى زيارة الاستقبال أو الرد على هذه الرسالة إذا كان لديك أي استفسار.",
      examples: [AR_NAME, "١٠٤٢"],
    },
  },
];

function build(def: Def, lang: "en" | "ar"): GalleryItem {
  const copy = def[lang];
  const header: TemplateDraft["header"] = def.media
    ? { kind: "media", format: "IMAGE" }
    : copy.header
      ? { kind: "text", text: copy.header }
      : { kind: "none" };
  const buttons = copy.buttons ?? [];
  const draft = emptyDraft({
    name: `${def.key}_${lang}`,
    language: lang,
    category: def.category,
    type: def.media || buttons.length ? "media_interactive" : "standard",
    header,
    body: copy.body,
    bodyExamples: copy.examples,
    footer: copy.footer ?? "",
    buttons,
    variableMap: def.map,
  });
  return {
    key: `${def.key}_${lang}`,
    title: `${def.title}${lang === "ar" ? " (Arabic)" : " (English)"}`,
    description: def.description,
    useCase: def.useCase,
    language: lang,
    needsMedia: !!def.media,
    placeholderLink: buttons.some((b) => b.type === "URL" && /example\.(com|org)/.test(b.url)),
    draft,
  };
}

export const GALLERY: readonly GalleryItem[] = DEFS.flatMap((d) => [
  build(d, "en"),
  build(d, "ar"),
]);

export const GALLERY_USE_CASES: readonly GalleryUseCase[] = [
  "Appointments",
  "Welcome & follow-up",
  "Feedback",
  "Marketing",
  "Billing",
];

export function galleryItem(key: string): GalleryItem | undefined {
  return GALLERY.find((g) => g.key === key);
}
