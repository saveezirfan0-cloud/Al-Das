import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { can } from "@/lib/auth/can";
import { FINANCE_ROLES, PERMISSION_KEYS, SYSTEM_ROLES } from "@/lib/auth/permissions";
import {
  allFields,
  INTEGRATIONS,
  INTEGRATION_KINDS,
  integrationDef,
  isIntegrationKind,
  needsConfirmation,
  providerDef,
  validateFields,
} from "@/lib/integrations/catalog";
import { CALL_PROVIDERS, classifyHealth, foldCallStats } from "@/lib/integrations/health";
import { confirmationMatches, readinessProblems } from "@/lib/integrations/readiness";
import { visibleSettingsPages } from "@/components/shell/settings-pages";

const member = (permissions: string[]) => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active" as const,
  permissions,
});

describe("catalogue", () => {
  it("lists every kind once, with real permission keys", () => {
    expect(INTEGRATIONS.map((i) => i.kind).sort()).toEqual([...INTEGRATION_KINDS].sort());
    for (const i of INTEGRATIONS) {
      expect(PERMISSION_KEYS).toContain(i.viewPermission);
      expect(isIntegrationKind(i.kind)).toBe(true);
    }
    expect(isIntegrationKind("unite")).toBe(false);
  });

  it("requires typed confirmation for everything that messages patients, takes money, shares patient data or accepts files, and nothing else", () => {
    for (const i of INTEGRATIONS) {
      const expected =
        i.contactsPatients || i.movesMoney || i.sharesData || i.acceptsFiles === true;
      expect(needsConfirmation(i.kind), i.kind).toBe(expected);
      expect(i.confirmWord !== null, i.kind).toBe(expected);
    }
    expect(integrationDef("sms").confirmWord).toBe("ENABLE SMS");
    expect(integrationDef("payments").confirmWord).toBe("ENABLE PAYMENTS");
    expect(integrationDef("calendar_ics").confirmWord).toBeNull();
    expect(integrationDef("finance_mailbox").confirmWord).toBe("ACCEPT MAILBOX ATTACHMENTS");
  });

  it("marks every credential as secret and keeps identifiers out of the encrypted blob", () => {
    const secretKeys = INTEGRATIONS.flatMap((i) =>
      i.providers.flatMap((p) => p.fields.filter((f) => f.secret).map((f) => f.key)),
    ).sort();
    expect(secretKeys).toEqual(
      // api_key: Daily (video rooms) and Dropbox Sign (e-signature); Phase 20e: Instagram and Messenger (page token, app secret,
      // verify token each) and the Google OAuth client secret
      [
        "access_token",
        "api_key",
        "api_key",
        "auth_token",
        "secret_key",
        "server_key",
        // Stripe's signing secret and the finance mailbox's webhook password
        "webhook_secret",
        "webhook_secret",
        "page_access_token",
        "page_access_token",
        "app_secret",
        "app_secret",
        "verify_token",
        "verify_token",
        "client_secret",
      ].sort(),
    );
    for (const i of INTEGRATIONS)
      for (const f of allFields(i.kind, i.providers[0].id))
        if (f.secret) expect(f.type).toBe("password");
  });

  it("looks providers up, falling back to the only one", () => {
    expect(providerDef("sms", "twilio")?.id).toBe("twilio");
    expect(providerDef("sms", null)?.id).toBe("twilio");
    expect(providerDef("payments", null)).toBeNull();
    expect(providerDef("payments", "paytabs")?.id).toBe("paytabs");
  });
});

describe("permissions and presets", () => {
  it("integrations.manage is not granted to any preset except through Admin's wildcard", () => {
    for (const r of SYSTEM_ROLES)
      if (r.name !== "Admin") expect(r.permissions).not.toContain("integrations.manage");
    expect(can(member(["*"]), "integrations.manage")).toBe(true);
    expect(can(member(["settings.manage"]), "integrations.manage")).toBe(false);
  });

  it("doctors' calendars go to the Manager; payment links only to Finance (and the Finance Manager, a superset) and Billing", () => {
    const has = (name: string, key: string) =>
      SYSTEM_ROLES.find((r) => r.name === name)!.permissions.includes(key);
    expect(has("Manager", "integrations.calendar")).toBe(true);
    expect(has("Agent", "integrations.calendar")).toBe(false);
    expect(
      FINANCE_ROLES.filter((r) => r.permissions.includes("finance.payment_links"))
        .map((r) => r.name)
        .sort(),
    ).toEqual(["Billing", "Finance", "Finance Manager"]);
  });

  it("finance.payment_links is its own key: no neighbour implies it", () => {
    for (const neighbour of [
      "finance.recovery.manage",
      "finance.view",
      "finance.invoices.view",
      "finance.*",
    ])
      expect(can(member([neighbour]), "finance.payment_links"), neighbour).toBe(
        neighbour === "finance.*",
      );
  });

  it("the Integrations settings page is visible to exactly the two integration permissions", () => {
    const sees = (p: string[]) =>
      visibleSettingsPages(member(p)).some((x) => x.href === "/settings/integrations");
    expect(sees(["integrations.manage"])).toBe(true);
    expect(sees(["integrations.calendar"])).toBe(true);
    expect(sees(["settings.manage"])).toBe(false);
    expect(sees([])).toBe(false);
  });
});

describe("validateFields", () => {
  const sms = allFields("sms", "twilio");

  it("keeps secrets apart from settings and applies defaults", () => {
    const r = validateFields(sms, {
      account_sid: "AC1",
      auth_token: "tok",
      sender: "ALDAS",
      clinic_name: "Clinic",
      callback_phone: "+97140000000",
      rate_per_sec: "",
      daily_cap: "50",
    });
    expect(r).toEqual({
      ok: true,
      secrets: { auth_token: "tok" },
      config: {
        account_sid: "AC1",
        sender: "ALDAS",
        clinic_name: "Clinic",
        callback_phone: "+97140000000",
        rate_per_sec: 5,
        daily_cap: 50,
        segment_price: "",
      },
    });
  });

  it("a blank secret keeps the stored one, and is an error only when nothing is stored", () => {
    const base = { account_sid: "AC1", sender: "S", clinic_name: "C", callback_phone: "+1" };
    expect(validateFields(sms, { ...base, auth_token: "" }, { auth_token: true })).toMatchObject({
      ok: true,
      secrets: {},
    });
    expect(validateFields(sms, { ...base, auth_token: "" }, {})).toEqual({
      ok: false,
      error: "Auth token is required.",
    });
  });

  it("checks required fields, ranges, lengths, urls and select options", () => {
    const pay = allFields("payments", "stripe");
    const ok = { secret_key: "sk", webhook_secret: "wh", currency: "AED" };
    expect(validateFields(pay, { ...ok, link_expiry_hours: 25 })).toMatchObject({ ok: false });
    expect(validateFields(pay, { ...ok, link_expiry_hours: 0 })).toMatchObject({ ok: false });
    expect(validateFields(pay, { ...ok, link_expiry_hours: "1.5" })).toMatchObject({ ok: false });
    expect(validateFields(pay, { ...ok, currency: "XYZ" })).toMatchObject({ ok: false });
    expect(validateFields(pay, { ...ok, return_url: "http://insecure.test" })).toMatchObject({
      ok: false,
    });
    expect(validateFields(pay, { ...ok, return_url: "https://user:pw@x.test/" })).toMatchObject({
      ok: false,
    });
    expect(validateFields(pay, { ...ok, return_url: "javascript:alert(1)" })).toMatchObject({
      ok: false,
    });
    expect(validateFields(pay, { ...ok, return_url: "https://clinic.test/thanks" })).toMatchObject({
      ok: true,
    });
    expect(
      validateFields(sms, {
        account_sid: "A".repeat(70),
        auth_token: "t",
        sender: "S",
        clinic_name: "C",
        callback_phone: "+1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateFields(sms, {
        account_sid: "AC\u0000",
        auth_token: "t",
        sender: "S",
        clinic_name: "C",
        callback_phone: "+1",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("readiness", () => {
  const smsReady = {
    kind: "sms" as const,
    provider: "twilio",
    config: { account_sid: "AC", sender: "S", clinic_name: "C", callback_phone: "+1" },
    secretsStored: { auth_token: true },
  };

  it("lists what is missing", () => {
    expect(readinessProblems(smsReady)).toEqual([]);
    expect(readinessProblems({ ...smsReady, secretsStored: {} })).toContain(
      "Auth token is missing.",
    );
    expect(
      readinessProblems({ ...smsReady, config: { ...smsReady.config, sender: "" } }),
    ).toContain("Registered sender ID is missing.");
    expect(
      readinessProblems({ kind: "payments", provider: null, config: {}, secretsStored: {} }),
    ).toEqual(["Choose a provider."]);
    expect(
      readinessProblems({ kind: "calendar_ics", provider: "ics", config: {}, secretsStored: {} }),
    ).toEqual([]);
  });

  it("payments also need an approved, Utility, fully mapped template that carries the link", () => {
    const base = {
      kind: "payments" as const,
      provider: "stripe",
      config: { currency: "AED" },
      secretsStored: { secret_key: true, webhook_secret: true },
    };
    expect(readinessProblems({ ...base, template: null })).toContain(
      "Choose the WhatsApp template used for the payment message.",
    );
    const good = {
      status: "APPROVED",
      category: "UTILITY",
      mappedAll: true,
      hasLinkVariable: true,
      unsupported: false,
    };
    expect(readinessProblems({ ...base, template: good })).toEqual([]);
    expect(readinessProblems({ ...base, template: { ...good, status: "PENDING" } })).toContain(
      "The payment template is not approved by Meta.",
    );
    expect(readinessProblems({ ...base, template: { ...good, category: "MARKETING" } })).toContain(
      "The payment template must be in the Utility category.",
    );
    expect(readinessProblems({ ...base, template: { ...good, mappedAll: false } })).toContain(
      "Map every variable of the payment template.",
    );
    expect(readinessProblems({ ...base, template: { ...good, hasLinkVariable: false } })).toContain(
      "Map one variable of the payment template to the payment link.",
    );
    expect(readinessProblems({ ...base, template: { ...good, unsupported: true } }).length).toBe(1);
  });

  it("matches the confirmation words exactly (after trimming)", () => {
    expect(confirmationMatches("sms", "ENABLE SMS")).toBe(true);
    expect(confirmationMatches("sms", "  ENABLE SMS ")).toBe(true);
    expect(confirmationMatches("sms", "enable sms")).toBe(false);
    expect(confirmationMatches("payments", "ENABLE SMS")).toBe(false);
    expect(confirmationMatches("calendar_ics", "")).toBe(true);
  });
});

describe("health", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const base = {
    enabled: true,
    outbound: true,
    breakerOpenUntil: null,
    lastOkAt: null,
    lastErrorAt: null,
    calls: 0,
    failedCalls: 0,
  };

  it("classifies", () => {
    expect(classifyHealth({ ...base, enabled: false }, now)).toBe("off");
    expect(classifyHealth({ ...base, outbound: false }, now)).toBe("ok");
    expect(classifyHealth(base, now)).toBe("idle");
    expect(classifyHealth({ ...base, calls: 10, lastOkAt: "2026-10-18T11:00:00Z" }, now)).toBe(
      "ok",
    );
    expect(
      classifyHealth({ ...base, calls: 10, failedCalls: 1, lastOkAt: "2026-10-18T11:00:00Z" }, now),
    ).toBe("degraded");
    expect(classifyHealth({ ...base, calls: 10, failedCalls: 6 }, now)).toBe("down");
    expect(classifyHealth({ ...base, calls: 2, failedCalls: 2 }, now)).toBe("degraded");
    expect(classifyHealth({ ...base, breakerOpenUntil: "2026-10-18T12:05:00Z" }, now)).toBe("down");
    expect(
      classifyHealth(
        { ...base, breakerOpenUntil: "2026-10-18T11:55:00Z", lastOkAt: "2026-10-18T10:00:00Z" },
        now,
      ),
    ).toBe("ok");
    expect(
      classifyHealth(
        {
          ...base,
          calls: 3,
          lastOkAt: "2026-10-18T09:00:00Z",
          lastErrorAt: "2026-10-18T10:00:00Z",
        },
        now,
      ),
    ).toBe("degraded");
  });

  it("folds per-outcome rows for the right providers only", () => {
    const rows = [
      { provider: "twilio", outcome: "ok", calls: 8 },
      { provider: "twilio", outcome: "timeout", calls: 2 },
      { provider: "stripe", outcome: "ok", calls: 99 },
    ];
    expect(foldCallStats(rows, CALL_PROVIDERS.sms)).toEqual({ calls: 10, failedCalls: 2 });
    expect(foldCallStats(rows, CALL_PROVIDERS.calendar_ics)).toEqual({ calls: 0, failedCalls: 0 });
  });
});

/** Source-level guarantees of the Phase 19 rules. */
describe("source guards", () => {
  const ROOT = join(__dirname, "../../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory()
        ? walk(p)
        : p.endsWith(".ts") || p.endsWith(".tsx")
          ? [p]
          : [];
    });
  const files = [
    ...walk(join(ROOT, "lib/integrations")),
    join(ROOT, "lib/jobs/handlers/sms-outbound.ts"),
    ...walk(join(ROOT, "app/(app)/settings/integrations")),
    ...walk(join(ROOT, "app/(app)/finance/payment-links")),
    ...walk(join(ROOT, "app/api/calendar")),
    ...walk(join(ROOT, "app/api/webhooks/integrations")),
  ].map((f) => ({ rel: relative(ROOT, f), src: readFileSync(f, "utf8") }));

  it("finds the files (a scanner that sees nothing would pass everything)", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("never touches Unite", () => {
    for (const f of files) {
      expect(f.src, f.rel).not.toMatch(
        /lib\/unite|unite-mapping|uniteuae|UNITE_(BASE_URL|APP_ID|APP_KEY)|finance_capture/,
      );
    }
  });

  it("never writes to invoices, claims or Unite mirrors", () => {
    for (const f of files) {
      expect(f.src, f.rel).not.toMatch(
        /from\(\s*["'](fin_invoices|fin_invoice_lines|fin_payments|ins_claims|ins_activities)["']\s*\)\s*\.\s*(update|insert|upsert|delete)/,
      );
    }
  });

  it("builds provider HTTP only through the shared client (no bare fetch to a provider)", () => {
    for (const f of files.filter(
      (x) => x.rel.startsWith("lib/integrations") && x.rel !== "lib/integrations/client.ts",
    )) {
      expect(f.src, f.rel).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("never logs bodies, tokens or links", () => {
    for (const f of files) {
      for (const m of f.src.matchAll(/console\.(?:log|info|warn|error|debug)\s*\(([\s\S]*?)\);/g)) {
        expect(m[1], `${f.rel}: ${m[0].slice(0, 80)}`).not.toMatch(
          /\b(body|token|secret|password|authorization|url|link|payload|phone|amount)\b\s*[:,}]/i,
        );
      }
    }
  });

  it("client components never import the service role or crypto", () => {
    for (const f of files.filter((x) => /^\s*["']use client["']/.test(x.src))) {
      expect(f.src, f.rel).not.toMatch(
        /lib\/supabase\/admin|lib\/crypto|lib\/integrations\/accounts/,
      );
    }
  });

  it("every server action starts with a permission check", () => {
    for (const f of files.filter((x) => /^["']use server["']/.test(x.src))) {
      for (const m of f.src.matchAll(
        /export async function (\w+)\([^)]*\)[^{]*\{\s*(?:\n\s*)?const member = await (\w+)\(/g,
      )) {
        expect(m[2], `${f.rel}::${m[1]}`).toBe("requirePerm");
      }
      const exported = [...f.src.matchAll(/export async function (\w+)/g)].length;
      const guarded = [
        ...f.src.matchAll(
          /export async function \w+\([^)]*\)[^{]*\{\s*(?:\n\s*)?const member = await requirePerm\(/g,
        ),
      ].length;
      expect(guarded, f.rel).toBe(exported);
    }
  });
});
