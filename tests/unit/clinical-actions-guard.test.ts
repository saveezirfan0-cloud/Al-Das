import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Patient 360 clinical actions (docs/45 P3): every exported action must pass through clinicalMember(), which needs
 * contacts.view AND clinical.view, and must record the open. A new action that skips either fails here.
 */
const file = path.join(process.cwd(), "app", "(app)", "contacts", "[id]", "clinical-actions.ts");
const src = readFileSync(file, "utf8");

function bodies(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /export async function (\w+)\(/g;
  const starts: Array<{ name: string; at: number }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) =>
    out.push({ name: s.name, body: src.slice(s.at, starts[i + 1]?.at ?? src.length) }),
  );
  return out;
}

describe("clinical-actions guard", () => {
  it("has the actions we expect", () => {
    expect(bodies().map((b) => b.name)).toEqual([
      "listContactVisits",
      "getContactConditions",
      "getContactCare",
      "getClinicalOverview",
    ]);
  });

  it("clinicalMember requires contacts.view and clinical.view", () => {
    const m = /async function clinicalMember[\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
    expect(m).toContain('requirePerm("contacts.view")');
    expect(m).toContain('can(member, "clinical.view")');
  });

  it("every action checks clinical.view, validates the id, reads with the member's own client and records the open", () => {
    for (const { name, body } of bodies()) {
      expect(body, name).toContain("await clinicalMember()");
      expect(body, name).toContain("uuid.safeParse(contactId)");
      expect(body, name).toContain("await createClient()");
      expect(body, name).not.toContain("createAdminClient(");
      expect(body, name).toContain("await logOpen(");
    }
  });

  it("never selects raw notes", () => {
    expect(src).not.toMatch(
      /observation_notes_raw|doctor_notes|nurse_notes|reply_text|symptoms_reported/,
    );
  });
});
