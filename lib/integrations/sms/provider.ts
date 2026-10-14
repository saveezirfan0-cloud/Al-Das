import "server-only";

import {
  dbBreakerStore,
  dbCallSink,
  readSecrets,
  readConfig,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { readSmsConfig } from "@/lib/integrations/sms/config";
import { createHttpSmsProvider } from "@/lib/integrations/sms/http";
import { readHttpSmsConfig } from "@/lib/integrations/sms/http-config";
import { createTwilioProvider } from "@/lib/integrations/sms/twilio";
import type { SmsProvider } from "@/lib/integrations/sms/types";
import type { AdminClient } from "@/lib/supabase/admin";

/** The configured SMS provider for an account, with call logging and the stored circuit breaker. Null when credentials are missing. */
export function buildSmsProvider(admin: AdminClient, account: AccountRow): SmsProvider | null {
  const config = readSmsConfig(readConfig(account));
  const secrets = readSecrets(account);
  if (config.provider === "twilio") {
    if (!config.accountSid || !secrets.auth_token || !config.sender) return null;
    return createTwilioProvider({
      accountSid: config.accountSid,
      authToken: secrets.auth_token,
      sender: config.sender,
      sink: dbCallSink(admin, account.org_id),
      breaker: dbBreakerStore(admin, account.org_id, "sms"),
    });
  }
  if (config.provider === "http") {
    // Phase 20h: the generic HTTP gateway. The factory refuses settings it cannot use (address, template, sign-in).
    if (!secrets.gateway_secret || !config.sender) return null;
    return createHttpSmsProvider({
      ...readHttpSmsConfig(readConfig(account)),
      secret: secrets.gateway_secret,
      sender: config.sender,
      sink: dbCallSink(admin, account.org_id),
      breaker: dbBreakerStore(admin, account.org_id, "sms"),
    });
  }
  return null;
}
