/**
 * Starter gallery: original clinic templates in English and Arabic.
 * Text is written for Pulse; nothing is copied from another product's library.
 * Placeholders only, no patient data. Media samples, phone numbers and links are
 * left for the clinic to supply (see `needs`), and `validateBuilder` refuses to
 * submit while a placeholder link or empty phone number remains.
 */
import {
  PLACEHOLDER_HOST,
  emptyBuilderState,
  type BuilderState,
  type ButtonDef,
  type CardDef,
  type HeaderDef,
  type TemplateCategory,
  type TemplateType,
} from "@/lib/whatsapp/template-builder";

export const GALLERY_USE_CASES = [
  "appointments",
  "follow_up",
  "recall",
  "billing",
  "information",
  "promotions",
  "security",
] as const;
export type GalleryUseCase = (typeof GALLERY_USE_CASES)[number];

export const USE_CASE_LABELS: Record<GalleryUseCase, string> = {
  appointments: "Appointments",
  follow_up: "Follow-up & feedback",
  recall: "Recalls & reminders",
  billing: "Billing & documents",
  information: "Clinic information",
  promotions: "Promotions",
  security: "Security",
};

type Lang = "en" | "ar";

type Variant = {
  header?: HeaderDef;
  body: string;
  examples: string[];
  footer?: string;
  buttons?: ButtonDef[];
  cards?: CardDef[];
};

export type GalleryTemplate = {
  /** Also the Meta template name. */
  key: string;
  category: TemplateCategory;
  type: TemplateType;
  useCase: GalleryUseCase;
  title: Record<Lang, string>;
  summary: string;
  /** Default variable map ("body.1" → contact field), applied when the draft is created. */
  variableMap: Record<string, string>;
  /** What the clinic still has to provide before submitting. */
  needs: Array<"media" | "phone" | "link">;
  en: Variant;
  ar: Variant;
};

const qr = (text: string) => ({ type: "QUICK_REPLY" as const, text });

const CONFIRM_EN = [qr("Confirm"), qr("Reschedule"), qr("Cancel")];
const CONFIRM_AR = [qr("تأكيد"), qr("إعادة جدولة"), qr("إلغاء")];

const FIRST_NAME = { "body.1": "contact.first_name" };

export const GALLERY: GalleryTemplate[] = [
  {
    key: "appointment_confirmation",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "appointments",
    title: { en: "Appointment confirmed", ar: "تأكيد الموعد" },
    summary: "Confirms a booked visit with doctor, date and time, with quick replies.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, your appointment with {{2}} is booked for {{3}} at {{4}}. Please use the buttons below if anything needs to change.",
      examples: ["Sara", "Dr Example", "Monday 12 May", "10:30 AM"],
      buttons: CONFIRM_EN,
    },
    ar: {
      body: "مرحباً {{1}}، تم حجز موعدك مع {{2}} يوم {{3}} في تمام الساعة {{4}}. يمكنك استخدام الأزرار أدناه إذا احتجت إلى أي تغيير.",
      examples: ["سارة", "د. أحمد", "الاثنين 12 مايو", "10:30 صباحاً"],
      buttons: CONFIRM_AR,
    },
  },
  {
    key: "appointment_reminder_48h",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "appointments",
    title: { en: "Reminder, 2 days before", ar: "تذكير قبل يومين" },
    summary: "A gentle reminder two days ahead with confirm / reschedule / cancel.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hi {{1}}, this is a reminder of your visit with {{2}} on {{3}} at {{4}}. We look forward to seeing you. Let us know if your plans change.",
      examples: ["Sara", "Dr Example", "Wednesday 14 May", "4:00 PM"],
      buttons: CONFIRM_EN,
    },
    ar: {
      body: "أهلاً {{1}}، نذكّرك بموعدك مع {{2}} يوم {{3}} الساعة {{4}}. يسعدنا استقبالك، وأخبرنا إن تغيّرت خططك.",
      examples: ["سارة", "د. أحمد", "الأربعاء 14 مايو", "4:00 مساءً"],
      buttons: CONFIRM_AR,
    },
  },
  {
    key: "appointment_reminder_today",
    category: "UTILITY",
    type: "standard",
    useCase: "appointments",
    title: { en: "Reminder, same day", ar: "تذكير في يوم الموعد" },
    summary: "A short note on the morning of the visit.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Good morning {{1}}. Your appointment is today at {{2}}. Please arrive ten minutes early so we can check you in without delay.",
      examples: ["Sara", "11:15 AM"],
    },
    ar: {
      body: "صباح الخير {{1}}. موعدك اليوم في تمام الساعة {{2}}. نرجو الحضور قبل عشر دقائق لإتمام تسجيل الدخول دون تأخير.",
      examples: ["سارة", "11:15 صباحاً"],
    },
  },
  {
    key: "appointment_rescheduled",
    category: "UTILITY",
    type: "standard",
    useCase: "appointments",
    title: { en: "Appointment rescheduled", ar: "تغيير موعد" },
    summary: "Tells the patient their visit moved to a new time.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, your appointment has been moved to {{2}} at {{3}} with {{4}}. Thank you for your understanding.",
      examples: ["Sara", "Friday 16 May", "9:00 AM", "Dr Example"],
    },
    ar: {
      body: "مرحباً {{1}}، تم تغيير موعدك إلى يوم {{2}} الساعة {{3}} مع {{4}}. شكراً لتفهّمك.",
      examples: ["سارة", "الجمعة 16 مايو", "9:00 صباحاً", "د. أحمد"],
    },
  },
  {
    key: "appointment_cancelled",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "appointments",
    title: { en: "Appointment cancelled", ar: "إلغاء موعد" },
    summary: "Confirms a cancellation and offers to book again.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, your appointment on {{2}} has been cancelled. If you would like a new time, tap the button and our team will help.",
      examples: ["Sara", "Monday 12 May"],
      buttons: [qr("Book a new time")],
    },
    ar: {
      body: "مرحباً {{1}}، تم إلغاء موعدك بتاريخ {{2}}. إذا رغبت في موعد جديد فاضغط على الزر وسيساعدك فريقنا.",
      examples: ["سارة", "الاثنين 12 مايو"],
      buttons: [qr("حجز موعد جديد")],
    },
  },
  {
    key: "missed_appointment",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "appointments",
    title: { en: "Missed appointment", ar: "موعد فائت" },
    summary: "Checks in after a no-show and offers to rebook.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hi {{1}}, we missed you at your appointment today with {{2}}. We hope everything is fine. Would you like to arrange another time?",
      examples: ["Sara", "Dr Example"],
      buttons: [qr("Rebook"), qr("Not now")],
    },
    ar: {
      body: "أهلاً {{1}}، افتقدناك في موعدك اليوم مع {{2}}. نتمنى أن يكون كل شيء على ما يرام. هل ترغب في ترتيب موعد آخر؟",
      examples: ["سارة", "د. أحمد"],
      buttons: [qr("إعادة الحجز"), qr("ليس الآن")],
    },
  },
  {
    key: "post_visit_followup",
    category: "UTILITY",
    type: "standard",
    useCase: "follow_up",
    title: { en: "After your visit", ar: "بعد الزيارة" },
    summary: "A caring follow-up after a visit; invites questions by reply.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, thank you for visiting {{2}}. We hope you are feeling better. If you have any questions about your visit, just reply here and our team will get back to you.",
      examples: ["Sara", "Al Das Medical"],
    },
    ar: {
      body: "مرحباً {{1}}، شكراً لزيارتك {{2}}. نتمنى لك الصحة والعافية. إذا كان لديك أي استفسار عن زيارتك فيمكنك الرد هنا وسيتواصل معك فريقنا.",
      examples: ["سارة", "الداس الطبي"],
    },
  },
  {
    key: "feedback_request",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "follow_up",
    title: { en: "Feedback request", ar: "طلب رأيك" },
    summary: "Asks for a rating through a link with a per-visit suffix.",
    variableMap: FIRST_NAME,
    needs: ["link"],
    en: {
      body: "Hi {{1}}, how was your visit today? Your feedback helps us look after every patient better. It takes less than a minute.",
      examples: ["Sara"],
      buttons: [
        {
          type: "URL",
          text: "Share feedback",
          url: `https://${PLACEHOLDER_HOST}/feedback/{{1}}`,
          example: `https://${PLACEHOLDER_HOST}/feedback/visit123`,
        },
      ],
    },
    ar: {
      body: "أهلاً {{1}}، كيف كانت زيارتك اليوم؟ رأيك يساعدنا على تقديم رعاية أفضل لكل مريض، ولن يستغرق أكثر من دقيقة.",
      examples: ["سارة"],
      buttons: [
        {
          type: "URL",
          text: "شاركنا رأيك",
          url: `https://${PLACEHOLDER_HOST}/feedback/{{1}}`,
          example: `https://${PLACEHOLDER_HOST}/feedback/visit123`,
        },
      ],
    },
  },
  {
    key: "results_ready",
    category: "UTILITY",
    type: "standard",
    useCase: "follow_up",
    title: { en: "Results ready", ar: "النتائج جاهزة" },
    summary: "Says results are ready without sharing any clinical detail.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, your results from {{2}} are now ready. For your privacy we do not share them here. Please contact the clinic or use the patient portal to view them.",
      examples: ["Sara", "10 May"],
    },
    ar: {
      body: "مرحباً {{1}}، نتائجك بتاريخ {{2}} أصبحت جاهزة. حفاظاً على خصوصيتك لا نرسلها هنا، يرجى التواصل مع العيادة أو استخدام بوابة المريض للاطلاع عليها.",
      examples: ["سارة", "10 مايو"],
    },
  },
  {
    key: "prescription_refill_reminder",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "recall",
    title: { en: "Prescription refill", ar: "تجديد الوصفة" },
    summary: "Reminds a patient their prescription is due for review.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hi {{1}}, your prescription may be due for a refill around {{2}}. To keep your treatment on track, please book a short review with your doctor.",
      examples: ["Sara", "20 May"],
      buttons: [qr("Book a review"), qr("Already done")],
    },
    ar: {
      body: "أهلاً {{1}}، قد يحين موعد تجديد وصفتك الطبية قرابة {{2}}. لضمان استمرار علاجك، نرجو حجز مراجعة قصيرة مع طبيبك.",
      examples: ["سارة", "20 مايو"],
      buttons: [qr("حجز مراجعة"), qr("تم ذلك")],
    },
  },
  {
    key: "chronic_care_recall",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "recall",
    title: { en: "Three-month check-up", ar: "فحص دوري كل ثلاثة أشهر" },
    summary: "Invites chronic-care patients back about 90 days after their last review.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, it has been about three months since your last check-up with us. Regular reviews help keep your care on track. Would you like to book a visit?",
      examples: ["Sara"],
      buttons: [qr("Book a visit"), qr("Remind me later")],
    },
    ar: {
      body: "مرحباً {{1}}، مرّت نحو ثلاثة أشهر على آخر فحص لك لدينا. المراجعات الدورية تساعد على استمرار رعايتك بالشكل الأمثل. هل ترغب في حجز زيارة؟",
      examples: ["سارة"],
      buttons: [qr("حجز زيارة"), qr("ذكّرني لاحقاً")],
    },
  },
  {
    key: "vaccination_due",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "recall",
    title: { en: "Vaccination due", ar: "موعد التطعيم" },
    summary: "Lets a family know a vaccination is due and offers a booking.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, a vaccination for {{2}} is due on or around {{3}}. Reply with the button below and we will find a convenient time.",
      examples: ["Sara", "your child", "1 June"],
      buttons: [qr("Book vaccination")],
    },
    ar: {
      body: "مرحباً {{1}}، حان موعد التطعيم الخاص بـ {{2}} في أو قرابة {{3}}. اضغط على الزر أدناه وسنرتب لك وقتاً مناسباً.",
      examples: ["سارة", "طفلك", "1 يونيو"],
      buttons: [qr("حجز التطعيم")],
    },
  },
  {
    key: "welcome_new_patient",
    category: "UTILITY",
    type: "standard",
    useCase: "information",
    title: { en: "Welcome, new patient", ar: "أهلاً بالمريض الجديد" },
    summary: "Confirms registration and invites the patient to save the number.",
    variableMap: { "body.2": "contact.first_name" },
    needs: [],
    en: {
      body: "Welcome to {{1}}, {{2}}. Your registration is complete. Save this number to message us about appointments and your care at any time.",
      examples: ["Al Das Medical", "Sara"],
    },
    ar: {
      body: "أهلاً بك في {{1}} يا {{2}}. اكتمل تسجيلك لدينا. احفظ هذا الرقم لتتواصل معنا بخصوص مواعيدك ورعايتك في أي وقت.",
      examples: ["الداس الطبي", "سارة"],
    },
  },
  {
    key: "payment_receipt",
    category: "UTILITY",
    type: "standard",
    useCase: "billing",
    title: { en: "Payment received", ar: "استلام الدفعة" },
    summary: "Acknowledges a payment with amount and date.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, we have received your payment of {{2}} on {{3}}. Thank you. A receipt is available at the front desk on request.",
      examples: ["Sara", "AED 250", "12 May"],
    },
    ar: {
      body: "مرحباً {{1}}، استلمنا دفعتك بمبلغ {{2}} بتاريخ {{3}}. شكراً لك. يمكنك طلب الإيصال من مكتب الاستقبال.",
      examples: ["سارة", "250 درهماً", "12 مايو"],
    },
  },
  {
    key: "insurance_documents_reminder",
    category: "UTILITY",
    type: "standard",
    useCase: "billing",
    title: { en: "Bring your documents", ar: "المستندات المطلوبة" },
    summary: "Asks the patient to bring insurance card and ID.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, please bring your insurance card and a valid ID to your appointment on {{2}} so we can check you in quickly.",
      examples: ["Sara", "Monday 12 May"],
    },
    ar: {
      body: "مرحباً {{1}}، يرجى إحضار بطاقة التأمين وهوية سارية إلى موعدك بتاريخ {{2}} لنتمكن من إنهاء إجراءات دخولك بسرعة.",
      examples: ["سارة", "الاثنين 12 مايو"],
    },
  },
  {
    key: "holiday_hours_notice",
    category: "UTILITY",
    type: "standard",
    useCase: "information",
    title: { en: "Holiday opening hours", ar: "ساعات العمل في الإجازة" },
    summary: "Announces adjusted opening hours.",
    variableMap: {},
    needs: [],
    en: {
      body: "Dear patient, {{1}} will have adjusted opening hours on {{2}}: {{3}}. For urgent needs please call the clinic. We apologise for any inconvenience.",
      examples: ["Al Das Medical", "Eid Al Fitr", "9 AM to 2 PM"],
    },
    ar: {
      body: "عزيزي المريض، ستكون ساعات العمل في {{1}} مختلفة يوم {{2}}: {{3}}. للحالات العاجلة يرجى الاتصال بالعيادة. نعتذر عن أي إزعاج.",
      examples: ["الداس الطبي", "عيد الفطر", "من 9 صباحاً حتى 2 ظهراً"],
    },
  },
  {
    key: "clinic_directions",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "information",
    title: { en: "Directions to the clinic", ar: "كيفية الوصول للعيادة" },
    summary: "Sends a directions link and a call button.",
    variableMap: FIRST_NAME,
    needs: ["link", "phone"],
    en: {
      body: "Hello {{1}}, here is how to reach {{2}}. Tap a button for directions and parking details, or call us if you need help finding us.",
      examples: ["Sara", "our Palm Jumeirah clinic"],
      buttons: [
        {
          type: "URL",
          text: "Get directions",
          url: `https://${PLACEHOLDER_HOST}/directions`,
          example: "",
        },
        { type: "PHONE_NUMBER", text: "Call the clinic", phone_number: "" },
      ],
    },
    ar: {
      body: "مرحباً {{1}}، إليك طريقة الوصول إلى {{2}}. اضغط على أحد الأزرار لمعرفة الاتجاهات وتفاصيل المواقف، أو اتصل بنا إذا احتجت إلى مساعدة.",
      examples: ["سارة", "عيادتنا في نخلة جميرا"],
      buttons: [
        {
          type: "URL",
          text: "الاتجاهات",
          url: `https://${PLACEHOLDER_HOST}/directions`,
          example: "",
        },
        { type: "PHONE_NUMBER", text: "اتصل بالعيادة", phone_number: "" },
      ],
    },
  },
  {
    key: "pre_visit_instructions",
    category: "UTILITY",
    type: "media_interactive",
    useCase: "information",
    title: { en: "Before your visit (PDF)", ar: "قبل زيارتك (ملف PDF)" },
    summary: "Attaches a preparation sheet as a PDF header.",
    variableMap: FIRST_NAME,
    needs: ["media"],
    en: {
      header: { format: "DOCUMENT", handle: "" },
      body: "Hello {{1}}, please read the attached instructions before your {{2}} appointment. They explain how to prepare and what to bring.",
      examples: ["Sara", "dental"],
    },
    ar: {
      header: { format: "DOCUMENT", handle: "" },
      body: "مرحباً {{1}}، يرجى قراءة التعليمات المرفقة قبل موعدك في {{2}}. تشرح لك كيفية التحضير وما يجب إحضاره.",
      examples: ["سارة", "عيادة الأسنان"],
    },
  },
  {
    key: "birthday_greeting",
    category: "MARKETING",
    type: "media_interactive",
    useCase: "promotions",
    title: { en: "Birthday greeting", ar: "تهنئة عيد ميلاد" },
    summary: "A warm greeting; includes a one-tap way to stop promotions.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Happy birthday, {{1}}! Everyone at {{2}} wishes you good health and happiness in the year ahead.",
      examples: ["Sara", "Al Das Medical"],
      buttons: [qr("Stop promotions")],
    },
    ar: {
      body: "كل عام وأنت بخير يا {{1}}! يتمنى لك جميع فريق {{2}} الصحة والسعادة في عامك الجديد.",
      examples: ["سارة", "الداس الطبي"],
      buttons: [qr("إيقاف الرسائل الترويجية")],
    },
  },
  {
    key: "health_checkup_offer",
    category: "MARKETING",
    type: "media_interactive",
    useCase: "promotions",
    title: { en: "Health check-up offer", ar: "عرض الفحص الشامل" },
    summary: "A promotion with an image header and opt-out button.",
    variableMap: FIRST_NAME,
    needs: ["media"],
    en: {
      header: { format: "IMAGE", handle: "" },
      body: "Hi {{1}}, our full health check-up package is available until {{2}}. A little time now can protect your health for the year ahead. Reply to book.",
      examples: ["Sara", "30 June"],
      buttons: [qr("Book now"), qr("Stop promotions")],
    },
    ar: {
      header: { format: "IMAGE", handle: "" },
      body: "أهلاً {{1}}، باقة الفحص الصحي الشامل متاحة حتى {{2}}. القليل من وقتك الآن يحمي صحتك طوال العام. ردّ على هذه الرسالة للحجز.",
      examples: ["سارة", "30 يونيو"],
      buttons: [qr("احجز الآن"), qr("إيقاف الرسائل الترويجية")],
    },
  },
  {
    key: "new_service_announcement",
    category: "MARKETING",
    type: "media_interactive",
    useCase: "promotions",
    title: { en: "New service", ar: "خدمة جديدة" },
    summary: "Announces a new clinic service.",
    variableMap: FIRST_NAME,
    needs: [],
    en: {
      body: "Hello {{1}}, we are pleased to announce {{2}} at {{3}}. Reply to learn more or to book an appointment.",
      examples: ["Sara", "a new physiotherapy service", "our clinic"],
      buttons: [qr("Tell me more"), qr("Stop promotions")],
    },
    ar: {
      body: "مرحباً {{1}}، يسرّنا أن نعلن عن {{2}} في {{3}}. ردّ على هذه الرسالة لمعرفة المزيد أو لحجز موعد.",
      examples: ["سارة", "خدمة علاج طبيعي جديدة", "عيادتنا"],
      buttons: [qr("أخبرني المزيد"), qr("إيقاف الرسائل الترويجية")],
    },
  },
  {
    key: "services_carousel",
    category: "MARKETING",
    type: "carousel",
    useCase: "promotions",
    title: { en: "Services carousel", ar: "عرض الخدمات" },
    summary: "Two swipeable service cards, each with an image and a Book button.",
    variableMap: {},
    needs: ["media"],
    en: {
      body: "Our care, close to you. Swipe to see what we can do for you and your family.",
      examples: [],
      cards: [
        {
          format: "IMAGE",
          handle: "",
          body: "Family medicine for every age, with unhurried consultations.",
          examples: [],
          buttons: [qr("Book a visit")],
        },
        {
          format: "IMAGE",
          handle: "",
          body: "Dental care from check-ups to treatment, in a calm setting.",
          examples: [],
          buttons: [qr("Book a visit")],
        },
      ],
    },
    ar: {
      body: "رعايتنا قريبة منك. مرّر لتتعرف على ما يمكننا تقديمه لك ولعائلتك.",
      examples: [],
      cards: [
        {
          format: "IMAGE",
          handle: "",
          body: "طب الأسرة لجميع الأعمار، مع استشارات تأخذ وقتها الكامل.",
          examples: [],
          buttons: [qr("احجز زيارة")],
        },
        {
          format: "IMAGE",
          handle: "",
          body: "رعاية الأسنان من الفحص إلى العلاج في أجواء هادئة.",
          examples: [],
          buttons: [qr("احجز زيارة")],
        },
      ],
    },
  },
  {
    key: "verification_code",
    category: "AUTHENTICATION",
    type: "standard",
    useCase: "security",
    title: { en: "Verification code", ar: "رمز التحقق" },
    summary: "One-time code with a copy button (fixed format required by Meta).",
    variableMap: {},
    needs: [],
    en: { body: "", examples: [] },
    ar: { body: "", examples: [] },
  },
];

export function galleryEntry(key: string): GalleryTemplate | undefined {
  return GALLERY.find((g) => g.key === key);
}

/** The builder state for a gallery entry in one language (drafts start from this). */
export function galleryState(g: GalleryTemplate, lang: Lang): BuilderState {
  const v = g[lang];
  return emptyBuilderState({
    name: g.key,
    language: lang,
    category: g.category,
    type: g.type,
    header: v.header ?? { format: "NONE" },
    body: v.body,
    examples: [...v.examples],
    footer: v.footer ?? "",
    buttons: (v.buttons ?? []).map((b) => ({ ...b })),
    cards: (v.cards ?? []).map((c) => ({ ...c, buttons: c.buttons.map((b) => ({ ...b })) })),
  });
}
