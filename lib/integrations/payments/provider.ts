import "server-only";

import {
  dbBreakerStore,
  dbCallSink,
  readConfig,
  readSecrets,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { readPaymentsConfig } from "@/lib/integrations/payments/config";
import { createPaytabsProvider, PAYTABS_HOSTS } from "@/lib/integrations/payments/paytabs";
import { createStripeProvider } from "@/lib/integrations/payments/stripe";
import type { PaymentProvider } from "@/lib/integrations/payments/types";
import type { AdminClient } from "@/lib/supabase/admin";

/** The configured payment gateway client for an account, with call logging and the stored circuit breaker. Null if credentials are missing. */
export function buildPaymentProvider(
  admin: AdminClient,
  account: AccountRow,
): PaymentProvider | null {
  const cfg = readPaymentsConfig(readConfig(account));
  const secrets = readSecrets(account);
  const common = {
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "payments"),
  };
  if (cfg.provider === "stripe") {
    if (!secrets.secret_key) return null;
    return createStripeProvider({ secretKey: secrets.secret_key, ...common });
  }
  if (
    !secrets.server_key ||
    !cfg.profileId ||
    !(PAYTABS_HOSTS as readonly string[]).includes(cfg.regionHost)
  )
    return null;
  return createPaytabsProvider({
    serverKey: secrets.server_key,
    profileId: cfg.profileId,
    regionHost: cfg.regionHost,
    ...common,
  });
}
