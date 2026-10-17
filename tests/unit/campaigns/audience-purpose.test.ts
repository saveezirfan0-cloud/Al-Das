import { describe, expect, it } from "vitest";

import {
  audiencePurposeProblem,
  clinicalFieldsIn,
  segmentIdsIn,
} from "@/lib/campaigns/audience-purpose";
import { and, cond, or, type Filter } from "@/lib/filters/ast";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";

const registry = buildContactFieldRegistry({
  customFields: [{ key: "plan", label: "Plan", type: "select" }],
});

const f = (...c: ReturnType<typeof cond>[]): Filter => ({ include: and(...c), exclude: null });

const CLINICAL = [
  "lifecycle_stage",
  "last_visit",
  "visit_count",
  "visit_doctor",
  "visit_department",
  "chronic_condition",
  "diagnosis_group",
];
const NON_CLINICAL = ["age_band", "gender", "home_branch", "tags", "segments", "custom.plan"];

describe("field classification (conservative: derived from visits, doctors, diagnoses or visit dates = clinical)", () => {
  for (const k of CLINICAL)
    it(`${k} is clinical`, () => expect(registry.get(k)?.clinical).toBe(true));
  for (const k of NON_CLINICAL)
    it(`${k} is not clinical`, () => expect(registry.get(k)?.clinical).toBe(false));
  it("every field carries an explicit flag", () => {
    for (const d of registry.list()) expect(typeof d.clinical).toBe("boolean");
  });
});

describe("audiencePurposeProblem", () => {
  const clinical = f(cond("chronic_condition", "is_not_empty"));
  const plain = f(cond("gender", "eq", "female"), cond("age_band", "in", ["18_34"]));

  it("refuses a clinical filter for marketing", () => {
    expect(audiencePurposeProblem(clinical, "marketing", registry)).toMatch(/Care programmes only/);
  });
  it("allows a clinical filter for care", () => {
    expect(audiencePurposeProblem(clinical, "care", registry)).toBeNull();
  });
  it("allows a non-clinical filter for marketing", () => {
    expect(audiencePurposeProblem(plain, "marketing", registry)).toBeNull();
  });
  it("fails closed: no purpose or an unknown purpose counts as marketing", () => {
    expect(audiencePurposeProblem(clinical, undefined, registry)).not.toBeNull();
    expect(audiencePurposeProblem(clinical, null, registry)).not.toBeNull();
    expect(audiencePurposeProblem(clinical, "recall", registry)).not.toBeNull();
  });
  it("finds a clinical field nested in groups and in the exclusion group", () => {
    const nested: Filter = {
      include: and(
        cond("gender", "eq", "male"),
        or(cond("tags", "is_empty"), and(cond("visit_count", "gte", 2))),
      ),
      exclude: null,
    };
    expect(clinicalFieldsIn(nested, registry)).toEqual(["visit_count"]);
    const excluded: Filter = {
      include: and(cond("gender", "eq", "male")),
      exclude: and(cond("lifecycle_stage", "eq", "lapsed")),
    };
    expect(audiencePurposeProblem(excluded, "marketing", registry)).not.toBeNull();
  });
  it("treats an unknown field as clinical", () => {
    expect(
      audiencePurposeProblem(f(cond("mystery", "eq", "x")), "marketing", registry),
    ).not.toBeNull();
  });
  it("an empty or missing filter is fine", () => {
    expect(audiencePurposeProblem(null, "marketing", registry)).toBeNull();
    expect(audiencePurposeProblem({ include: and() }, "marketing", registry)).toBeNull();
  });
  it("names the fields without any values", () => {
    const msg = audiencePurposeProblem(
      f(cond("diagnosis_group", "has_any", ["secret-id"])),
      "marketing",
      registry,
    )!;
    expect(msg).toContain("Diagnosis group");
    expect(msg).not.toContain("secret-id");
  });
});

describe("registry gating by permission", () => {
  it("clinical fields are unavailable without clinical access", () => {
    const r = buildContactFieldRegistry({ clinicalAvailable: false });
    expect(r.get("lifecycle_stage")?.available).toBe(false);
    expect(() => r.require("visit_count")).toThrow();
    expect(r.get("age_band")?.available).toBe(true);
  });
});

describe("care-only fields and segments (docs/45 P5 follow-up)", () => {
  const CARE_ONLY = [
    "appointment_specialist",
    "appointment_service",
    "appointment_department",
    "appointment_notes",
    "enquiry_specialist",
    "conversation_ai_tags",
  ];

  for (const k of CARE_ONLY)
    it(`${k} is care only but stays available to a member without clinical access`, () => {
      expect(registry.get(k)?.careOnly).toBe(true);
      expect(registry.get(k)?.clinical).toBe(false);
      // Availability follows the relation only (AI tags are not offered yet), never clinical access.
      expect(buildContactFieldRegistry({ clinicalAvailable: false }).get(k)?.available).toBe(
        registry.get(k)?.available,
      );
      expect(audiencePurposeProblem(f(cond(k, "is_not_empty")), "marketing", registry)).toMatch(
        /Care programmes only/,
      );
      expect(audiencePurposeProblem(f(cond(k, "is_not_empty")), "care", registry)).toBeNull();
    });

  it("every field carries an explicit careOnly flag, custom fields are not care only", () => {
    for (const d of registry.list()) expect(typeof d.careOnly).toBe("boolean");
    expect(registry.get("custom.plan")?.careOnly).toBe(false);
  });

  it("a segment marked care only is refused for marketing even with a plain filter", () => {
    const plain = f(cond("gender", "eq", "female"));
    expect(audiencePurposeProblem(plain, "marketing", registry, { careOnly: false })).toBeNull();
    expect(audiencePurposeProblem(plain, "marketing", registry, { careOnly: true })).toMatch(
      /marked for care programmes only/,
    );
    expect(audiencePurposeProblem(plain, undefined, registry, { careOnly: true })).not.toBeNull();
    expect(audiencePurposeProblem(plain, "care", registry, { careOnly: true })).toBeNull();
  });

  it("names the health fields when the filter itself uses one", () => {
    expect(
      audiencePurposeProblem(f(cond("visit_count", "gt", 1)), "marketing", registry, {
        careOnly: true,
      }),
    ).toMatch(/Count of visits/);
  });
});

describe("segmentIdsIn", () => {
  it("lists the segments a filter includes or excludes, once each, ignoring other fields", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const filter: Filter = {
      include: and(cond("segments", "has_any", [a, b]), cond("gender", "eq", "female")),
      exclude: and(cond("segments", "has_any", [a])),
    };
    expect(segmentIdsIn(filter)).toEqual([a, b]);
    expect(segmentIdsIn(null)).toEqual([]);
    expect(segmentIdsIn({ include: and(cond("tags", "has_any", [a])), exclude: null })).toEqual([]);
  });
});
