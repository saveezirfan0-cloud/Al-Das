/**
 * Emergency wording, English and Arabic. PURE, deterministic, no model, no network: it works with the AI switch off.
 *
 * This is a SAFETY NET, not a classifier. It is deliberately broad (a false alarm costs a colleague a glance; a miss costs
 * far more) and it deliberately ignores negation: "no chest pain" still escalates, because a person should look. It cannot
 * understand every way a person writes: dialect spellings, transliterated Arabic written in Latin letters ("arabizi") and
 * misspellings are NOT covered, which is why the model path (intent detection) also looks for emergencies when it is on.
 * The word lists are for the clinical lead to review (docs/17_PHASE_17_NOTES.md).
 */

/** Maps Arabic letter variants onto one form (alef, ya, ta marbuta, hamza carriers) and removes harakat and tatweel. */
export function unifyArabic(input: string): string {
  return input
    .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, "") // harakat, small marks, tatweel
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // alef variants -> alef
    .replace(/\u0649/g, "\u064a") // alef maqsura -> ya
    .replace(/\u0629/g, "\u0647") // ta marbuta -> ha
    .replace(/\u0624/g, "\u0648") // waw with hamza -> waw
    .replace(/\u0626/g, "\u064a"); // ya with hamza -> ya
}

/** Lowercase, Unicode-compose, drop diacritics and tatweel, unify Arabic letter variants and digits, collapse spaces. */
export function normalizeForMatching(input: string): string {
  return unifyArabic(
    input
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ""), // invisible direction marks
  )
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic digits
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // Persian digits
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Pattern = { id: string; lang: "en" | "ar"; re: RegExp };

// English. Written against the normalised text (lowercase, punctuation replaced by spaces, apostrophes kept).
const EN: Pattern[] = [
  {
    id: "chest_pain",
    lang: "en",
    re: /\b(chest (pain|pains|pressure|tightness|is tight|hurts)|pain in (my|the|his|her) chest|tight chest|pressure in (my|the|his|her) chest)\b/,
  },
  {
    id: "breathing",
    lang: "en",
    re: /\b((can't|cant|cannot|can not|unable to|struggling to|hard to|difficult to|trouble|difficulty|not able to) (breathe|breathing)|short(ness)? of breath|not breathing|stopped breathing|stopped to breathe|gasping|choking)\b/,
  },
  {
    id: "bleeding",
    lang: "en",
    re: /\b((heavy|severe|serious|profuse|uncontrolled|massive) bleeding|bleeding (heavily|badly|a lot)|bleeding (won't|wont|will not|does not|doesn't|doesnt|isn't|isnt) (stop|stopping)|(won't|wont|can't|cant) stop bleeding|losing (a lot of )?blood|blood (everywhere|is pouring))\b/,
  },
  {
    id: "unconscious",
    lang: "en",
    re: /\b(unconscious|passed out|collapsed|fainted|unresponsive|not responding|won't wake up|wont wake up|not waking up)\b/,
  },
  {
    id: "seizure",
    lang: "en",
    re: /\b(seizure|seizures|convulsion|convulsions|convulsing|having a fit)\b/,
  },
  {
    id: "stroke",
    lang: "en",
    re: /\b(stroke|face (is )?drooping|slurred speech|sudden (weakness|numbness) (in|on))\b/,
  },
  { id: "cardiac", lang: "en", re: /\b(heart attack|cardiac arrest|heart (has )?stopped)\b/ },
  {
    id: "overdose",
    lang: "en",
    re: /\b(overdose|overdosed|took too many (pills|tablets)|swallowed (poison|bleach|pills))\b/,
  },
  {
    id: "self_harm",
    lang: "en",
    re: /\b(suicid\w*|kill myself|killing myself|end my life|ending my life|want to die|wanna die|self harm|harm myself|hurt myself|don't want to live|dont want to live)\b/,
  },
  {
    id: "allergy",
    lang: "en",
    re: /\b(anaphyla\w*|throat (is )?(swelling|closing)|swollen throat|tongue (is )?swelling|allergic reaction)\b/,
  },
  {
    id: "severe_pain",
    lang: "en",
    re: /\b((severe|unbearable|worst|extreme|excruciating|terrible) (pain|headache)|pain (is )?(unbearable|excruciating))\b/,
  },
  {
    id: "emergency_words",
    lang: "en",
    re: /\b(emergency|ambulance|urgent help|dying|life threatening|is dying|about to die|call 998|call 999|call 911)\b/,
  },
];

// Arabic. The sources are written in ordinary spelling and unified with the SAME mapping as the message (unifyArabic),
// so a pattern and a message always meet in one form.
const AR_SOURCES: Array<{ id: string; lang: "ar"; re: RegExp }> = [
  {
    id: "chest_pain",
    lang: "ar",
    re: /(الم|وجع|ضيق|ثقل|ضغط) (في|ب)?\s?(ال)?صدر|الم الصدر|وجع الصدر|(في|ب)(ال)?صدر (الم|وجع)/,
  },
  {
    id: "breathing",
    lang: "ar",
    re: /(ضيق|صعوبه|صعوبة|انقطاع|توقف|اختناق)( في| ب)?\s?(ال)?(تنفس|نفس)|(لا|ما|مو|مش) (استطيع|اقدر|قادر|عم اقدر) (ا|ان )?(ت)?(ال)?(تنفس|نفس)|(اتنفس|التنفس)\s?(صعب|مستحيل)|لا يتنفس|ما يتنفس|مختنق|اختنق/,
  },
  {
    id: "bleeding",
    lang: "ar",
    re: /(نزيف|نزف|دم)\s?(شديد|حاد|غزير|كثير|مستمر|لا يتوقف|ما يوقف|ما يتوقف|لا يقف)|(ينزف|تنزف|انزف)\s?(كثير|بشده|بغزاره)|نزيف لا/,
  },
  {
    id: "unconscious",
    lang: "ar",
    re: /فقدان (ال)?وعي|فاقد (ال)?وعي|فاقده (ال)?وعي|فقد (ال)?وعي|فقدت (ال)?وعي|اغمي عليه|اغمي عليها|اغماء|مغمي عليه|مغمي عليها|لا يستجيب|ما يستجيب|لا يتحرك/,
  },
  {
    id: "seizure",
    lang: "ar",
    re: /تشنج|نوبه صرع|نوبه (ال)?صرع|صرع (مفاجئ|الان)|يتشنج|ترتجف بشده/,
  },
  {
    id: "stroke",
    lang: "ar",
    re: /جلطه|سكته (دماغيه|قلبيه)|نوبه قلبيه|توقف (ال)?قلب|ثقل في (ال)?لسان|التواء (في )?(ال)?وجه/,
  },
  {
    id: "overdose",
    lang: "ar",
    re: /جرعه زائده|جرعه اكثر|بلع (سم|منظف|حبوب كثيره)|شرب (سم|منظف)|تسمم/,
  },
  {
    id: "self_harm",
    lang: "ar",
    re: /انتحار|انتحر|اقتل نفسي|اقتل نفسى|انهي حياتي|انهى حياتي|اريد (ان )?اموت|ابي اموت|ابغى اموت|ابغي اموت|اذي نفسي|ايذاء نفسي|اجرح نفسي|ما اريد اعيش|ما ابي اعيش/,
  },
  {
    id: "allergy",
    lang: "ar",
    re: /حساسيه شديده|تورم (في )?(ال)?(حلق|لسان|وجه)|انتفاخ (في )?(ال)?حلق|حلقي (يتورم|يغلق)/,
  },
  {
    id: "severe_pain",
    lang: "ar",
    re: /(الم|وجع|صداع)\s?(شديد|لا يطاق|فظيع|رهيب|قوي جدا|مبرح)|(الالم|الوجع)\s?(لا يطاق|فظيع|شديد)/,
  },
  {
    id: "emergency_words",
    lang: "ar",
    re: /اسعاف|طوارئ|حاله طارئه|حاله طوارئ|حاله حرجه|خطر على حياه|خطر علي حياه|يحتضر|بيموت|راح يموت|سيموت|اتصل (ب)?998|اتصل (ب)?999/,
  },
];

const AR: Pattern[] = AR_SOURCES.map((p) => ({ ...p, re: new RegExp(unifyArabic(p.re.source)) }));

export const EMERGENCY_PATTERN_IDS: readonly string[] = [
  ...new Set([...EN, ...AR].map((p) => p.id)),
];

export type EmergencyMatch = { matched: boolean; ids: string[]; languages: Array<"en" | "ar"> };

const MAX_SCAN_CHARS = 4000;

/** Does this patient message contain emergency wording? Returns pattern ids only, never the text. */
export function detectEmergency(text: string | null | undefined): EmergencyMatch {
  if (!text) return { matched: false, ids: [], languages: [] };
  const normalised = normalizeForMatching(text.slice(0, MAX_SCAN_CHARS));
  if (!normalised) return { matched: false, ids: [], languages: [] };
  const ids = new Set<string>();
  const langs = new Set<"en" | "ar">();
  for (const p of [...EN, ...AR]) {
    if (p.re.test(normalised)) {
      ids.add(p.id);
      langs.add(p.lang);
    }
  }
  return { matched: ids.size > 0, ids: [...ids], languages: [...langs] };
}
