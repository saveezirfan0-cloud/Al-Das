import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { integrationDef, needsConfirmation } from "@/lib/integrations/catalog";
import { CALL_PROVIDERS } from "@/lib/integrations/health";
import { readinessProblems } from "@/lib/integrations/readiness";
import { WhatsAppClient } from "@/lib/whatsapp/client";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { sendsThroughMmLite } from "@/lib/whatsapp/mm-lite";
import { parseWebhookBody } from "@/lib/whatsapp/parse";
import { fromWebhookStatus } from "@/lib/whatsapp/status";

/**
 * Phase 20h: Meta's Marketing Messages Lite API (MM Lite). Request, answer and webhook shapes are written from Meta's
 * documentation, not recorded from a live onboarded account (docs/30_PHASE_20H_SMS_MMLITE_NOTES.md). Fake fetch only.
 */

function client(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  const c = new WhatsAppClient({
    accessToken: "TOKEN",
    phoneNumberId: "PNID",
    wabaId: "WABA",
    graphVersion: "v21.0",
    fetch: fn as unknown as typeof fetch,
  });
  return { c, calls };
}

const TEMPLATE = {
  name: "spring_offer",
  language: { code: "en" },
  components: [{ type: "body" as const, parameters: [{ type: "text" as const, text: "Layla" }] }],
};

describe("which sends go through MM Lite", () => {
  const base = {
    specType: "template",
    campaignRecipientId: "rcp-1",
    templateCategory: "MARKETING",
    enabled: true,
  };

  it("only a campaign's Marketing template while the switch is on", () => {
    expect(sendsThroughMmLite(base)).toBe(true);
    expect(sendsThroughMmLite({ ...base, templateCategory: "marketing" })).toBe(true);
    expect(sendsThroughMmLite({ ...base, enabled: false })).toBe(false);
    expect(sendsThroughMmLite({ ...base, campaignRecipientId: null })).toBe(false);
    expect(sendsThroughMmLite({ ...base, campaignRecipientId: "" })).toBe(false);
    expect(sendsThroughMmLite({ ...base, templateCategory: "UTILITY" })).toBe(false);
    expect(sendsThroughMmLite({ ...base, templateCategory: "AUTHENTICATION" })).toBe(false);
    expect(sendsThroughMmLite({ ...base, templateCategory: null })).toBe(false);
    expect(sendsThroughMmLite({ ...base, specType: "text" })).toBe(false);
  });
});

describe("WhatsAppClient.sendMarketingTemplate", () => {
  it("posts the /messages body to /{phone-number-id}/marketing_messages", async () => {
    const { c, calls } = client([
      {
        body: {
          messaging_product: "whatsapp",
          contacts: [{ input: "971500000001", wa_id: "971500000001" }],
          messages: [{ id: "wamid.MMLITE1", message_status: "accepted" }],
        },
      },
    ]);
    const res = await c.sendMarketingTemplate("971500000001", TEMPLATE);
    expect(res.messages[0].id).toBe("wamid.MMLITE1");
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/PNID/marketing_messages");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "971500000001",
      type: "template",
      template: TEMPLATE,
    });
  });

  it("raises Meta errors the same way as /messages (131050 still sets stop_marketing downstream)", async () => {
    const { c } = client([
      {
        status: 400,
        body: { error: { code: 131050, message: "User has stopped marketing messages" } },
      },
    ]);
    const err = await c.sendMarketingTemplate("971500000001", TEMPLATE).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect((err as WhatsAppApiError).code).toBe(131050);
    expect((err as WhatsAppApiError).mapped.stopMarketing).toBe(true);
  });
});

describe("MM Lite status webhooks", () => {
  it("arrive on the messages field and map into the normal status flow by message id", () => {
    // Shape as documented for MM Lite: the usual status object; pricing category may read "marketing_lite" (unverified).
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "447700900001", phone_number_id: "PNID" },
                statuses: [
                  {
                    id: "wamid.MMLITE1",
                    status: "delivered",
                    timestamp: "1760000000",
                    recipient_id: "971500000001",
                    pricing: {
                      billable: true,
                      pricing_model: "PMP",
                      category: "marketing_lite",
                      type: "regular",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const parsed = parseWebhookBody(body);
    if (!parsed.ok) throw new Error(parsed.error);
    const status = parsed.events.find((e) => e.kind === "status");
    expect(status).toMatchObject({
      kind: "status",
      waMessageId: "wamid.MMLITE1",
      status: "delivered",
      pricingCategory: "marketing_lite",
      billable: true,
    });
    expect(fromWebhookStatus("delivered")).toBe("delivered");
  });
});

describe("the wa_mm_lite switch", () => {
  it("is off-by-default catalogue entry with typed words, no fields, no call log and no readiness blockers", () => {
    const def = integrationDef("wa_mm_lite");
    expect(def.confirmWord).toBe("SEND MARKETING THROUGH MM LITE");
    expect(needsConfirmation("wa_mm_lite")).toBe(true);
    expect(def.viewPermission).toBe("integrations.manage");
    expect(def.outbound).toBe(false);
    expect(def.commonFields).toHaveLength(0);
    expect(def.providers).toHaveLength(1);
    expect(CALL_PROVIDERS.wa_mm_lite).toEqual([]);
    expect(
      readinessProblems({ kind: "wa_mm_lite", provider: "meta", config: {}, secretsStored: {} }),
    ).toEqual([]);
  });

  it("the outbound job reaches MM Lite only through the channel's WhatsApp client, after every guard", () => {
    const src = readFileSync(join(__dirname, "../../lib/jobs/handlers/outbound.ts"), "utf8");
    expect(src).not.toMatch(/new WhatsAppClient/);
    const at = (s: string) => {
      const i = src.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const mm = at("client.sendMarketingTemplate(");
    for (const guard of [
      "isTrainingOrg(admin, message.org_id)",
      "guardCampaignMessage(",
      "isMarketingBlocked(tpl.category, contact.stop_marketing)",
      'admin.rpc("claim_send_slot"',
      "clientForChannel(admin, channel)",
    ])
      expect(at(guard), guard).toBeLessThan(mm);
  });
});
