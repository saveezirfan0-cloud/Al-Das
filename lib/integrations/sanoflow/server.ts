import "server-only";

import {
  dbBreakerStore,
  dbCallSink,
  readConfig,
  readSecrets,
  type AccountRow,
} from "@/lib/integrations/accounts";
import type { WebhookSpec } from "@/lib/integrations/webhook-route";
import { findContactsByPhone } from "@/lib/public-api/contacts";
import { attributeBooking, attributeExternalReply } from "@/lib/recall/attribution";
import type { AdminClient } from "@/lib/supabase/admin";

import { createSanoflowClient, type SanoflowClient } from "./client";
import { readSanoflowConfig, type SanoflowConfig } from "./config";
import {
  parseSanoflowStatus,
  sanoflowEventKey,
  verifySanoflowToken,
  type SanoflowStatusEvent,
} from "./webhook";

/** The Sanoflow client for an account, or null when no API key is stored. Every call is logged without bodies. */
export function buildSanoflowClientFor(
  admin: AdminClient,
  account: AccountRow,
  fetchFn?: typeof fetch,
): { client: SanoflowClient; config: SanoflowConfig } | null {
  const key = readSecrets(account).access_token;
  if (!key) return null;
  const client = createSanoflowClient({
    accessToken: key,
    fetchFn,
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "sanoflow"),
  });
  if (!client) return null;
  return { client, config: readSanoflowConfig(readConfig(account)) };
}

/**
 * Sanoflow's "patient replied / booked" webhook (receiveIntegrationWebhook does the 404 / size / token / rate-limit / claim
 * plumbing). The phone is matched to live contacts (primary or alternate number); each one's newest open recall send is
 * credited, as Make's "Chronic Update" did, except that only the newest send counts (OQ-22). Returns counts-free outcome words.
 */
export function sanoflowWebhookSpec(): WebhookSpec {
  return {
    kind: "sanoflow",
    provider: "sanoflow",
    verify: (ctx) => verifySanoflowToken(ctx.headers, ctx.search, ctx.secrets.webhook_token),
    parse: (raw, ctx) => {
      const e = parseSanoflowStatus(raw);
      return e ? [{ key: sanoflowEventKey(raw, ctx.nowMs), data: e }] : [];
    },
    handle: async (event, ctx) => {
      const e = event.data as SanoflowStatusEvent;
      const orgId = ctx.account.org_id;
      const contacts = (await findContactsByPhone(ctx.admin, orgId, e.phone)).slice(0, 5);
      if (contacts.length === 0) return "no_contact";
      const at = new Date(ctx.nowMs);
      let credited = 0;
      for (const c of contacts) {
        const ok =
          e.status === "replied"
            ? await attributeExternalReply(ctx.admin, { orgId, contactId: c.id, at })
            : await attributeBooking(ctx.admin, {
                orgId,
                contactId: c.id,
                appointmentId: null,
                at,
              });
        if (ok) credited++;
      }
      return credited ? `${e.status}_credited` : `${e.status}_no_open_send`;
    },
  };
}
