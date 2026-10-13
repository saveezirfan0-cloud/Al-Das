import type { IntegrationKind } from "@/lib/integrations/catalog";

/** Types shared by server code and client components (no runtime code, so safe to import anywhere). */
export type Secrets = Record<string, string>;
export type Config = Record<string, string | number>;

/** Everything the settings page may show: no ciphertext, no secret value, only whether each secret is stored. */
export type AccountView = {
  kind: IntegrationKind;
  exists: boolean;
  provider: string | null;
  enabled: boolean;
  status: string;
  config: Config;
  secretsStored: Record<string, boolean>;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  breakerOpenUntil: string | null;
  consecutiveFailures: number;
  enabledAt: string | null;
};
