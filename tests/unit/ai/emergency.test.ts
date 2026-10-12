import { describe, expect, it } from "vitest";

import { detectEmergency, normalizeForMatching } from "@/lib/ai/intent/emergency";

const hit = (t: string) => detectEmergency(t).matched;

describe("emergency wording: English", () => {
  it.each([
    "I have chest pain and my arm is numb",
    "He can't breathe!!",
    "my father is having difficulty breathing",
    "she is not breathing",
    "bleeding won't stop after the procedure",
    "severe bleeding since this morning",
    "my son is unconscious",
    "she fainted in the car",
    "My child is having a seizure",
    "I think it's a stroke, his face is drooping",
    "possible heart attack",
    "I took too many pills",
    "I want to kill myself",
    "i dont want to live anymore",
    "her throat is swelling after the injection",
    "the pain is unbearable",
    "Please send an ambulance",
    "this is an EMERGENCY",
    "CHEST   PAIN",
  ])("escalates: %s", (text) => {
    expect(hit(text)).toBe(true);
  });

  it("does not escalate ordinary requests", () => {
    for (const t of [
      "Hi, I'd like to book a check-up for next week",
      "What are your opening hours on Friday?",
      "How much is a dental cleaning?",
      "Can I get my blood test report by email?",
      "Thank you, see you tomorrow",
      "I need to reschedule my appointment",
      "Where is the Jumeirah branch?",
      "",
    ])
      expect(hit(t)).toBe(false);
  });

  it("deliberately ignores negation: a person should look at 'no chest pain' too", () => {
    expect(hit("I do not have chest pain, just a question about my visit")).toBe(true);
  });

  it("returns pattern ids and languages only, never the message", () => {
    const m = detectEmergency("I have chest pain, my number is 0501234567");
    expect(m).toEqual({ matched: true, ids: ["chest_pain"], languages: ["en"] });
    expect(JSON.stringify(m)).not.toContain("0501234567");
  });
});

describe("emergency wording: Arabic", () => {
  it.each([
    "عندي ألم في الصدر",
    "أبوي يعاني من ضيق في التنفس",
    "لا أستطيع التنفس",
    "ما أقدر أتنفس",
    "نزيف شديد بعد العملية",
    "النزيف لا يتوقف", // normalised: نزيف + لا يتوقف via the bleeding pattern with a prefix
    "فقدان الوعي",
    "اغمي عليه",
    "أغمي عليها فجأة",
    "ابني عنده تشنجات",
    "أظن أنها جلطة",
    "أريد أن أموت",
    "ابي اموت",
    "بدي انتحر",
    "جرعة زائدة من الدواء",
    "تورم في الحلق بعد الحقنة",
    "ألم لا يطاق",
    "نحتاج إسعاف الآن",
    "حالة طارئة",
    "هذه حالة طارئة!",
  ])("escalates: %s", (text) => {
    expect(hit(text)).toBe(true);
  });

  it("matches with diacritics, tatweel, mixed alef forms and Arabic-Indic digits in the surrounding text", () => {
    expect(hit("عِنْدِي أَلَـــمٌ فِي الصَّدْرِ")).toBe(true);
    expect(hit("إسعاف ٩٩٨")).toBe(true);
    expect(normalizeForMatching("أَلَـمٌ ١٢٣")).toBe("الم 123");
  });

  it("does not escalate ordinary Arabic requests", () => {
    for (const t of [
      "مرحبا، أريد حجز موعد الأسبوع القادم",
      "كم سعر الفحص العام؟",
      "ما هي ساعات العمل؟",
      "شكرا جزيلا",
      "هل يمكنني الحصول على تقرير التحليل؟",
    ])
      expect(hit(t)).toBe(false);
  });

  it("works on mixed English and Arabic in one message", () => {
    expect(hit("Hello مرحبا my mother has ألم في الصدر")).toBe(true);
  });
});

describe("robustness", () => {
  it("handles very long input quickly and never throws", () => {
    const start = Date.now();
    expect(hit("a ".repeat(100_000))).toBe(false);
    expect(hit("chest pain " + "x".repeat(1_000_000))).toBe(true); // only the first 4000 characters are scanned
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("cannot be hidden with invisible direction marks", () => {
    expect(hit("chest​ pain")).toBe(true);
    expect(hit("ألم‏ في‏ الصدر")).toBe(true);
  });

  it("handles null and undefined", () => {
    expect(detectEmergency(null).matched).toBe(false);
    expect(detectEmergency(undefined).matched).toBe(false);
  });
});
