import "server-only";

import { loadAccount, readConfig, readSecrets, recordFailure } from "@/lib/integrations/accounts";
import type { SigningIdentity } from "@/lib/signing/p12";
import { checkSealSecrets, sealConfig } from "@/lib/signing/seal";
import type { CertInfo } from "@/lib/signing/x509";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The organisation seal for one org, ready to sign, or null when the integration is off, incomplete or its certificate
 * is unusable (expired, wrong password, no signing key usage). Fails closed: no seal means the PDF is produced unsealed
 * with the visible "Not digitally sealed" line. A broken certificate on a switched-on seal is reported on the
 * integration's status (generic text, never the certificate or its password).
 */

export type OrgSeal = {
  identity: SigningIdentity;
  info: CertInfo;
  name: string;
  reason: string;
  location: string;
};

export async function loadOrgSeal(
  admin: AdminClient,
  orgId: string,
  now = new Date(),
): Promise<OrgSeal | null> {
  const row = await loadAccount(admin, orgId, "document_seal");
  if (!row?.enabled) return null;
  const check = checkSealSecrets(readSecrets(row), now);
  if (!check.ok) {
    await recordFailure(
      admin,
      orgId,
      "document_seal",
      "certificate unusable; documents are not sealed",
    );
    return null;
  }
  return { identity: check.identity, info: check.info, ...sealConfig(readConfig(row)) };
}

/** What the settings page shows about the stored seal certificate (public certificate data only). */
export async function sealCertificateSummary(
  admin: AdminClient,
  orgId: string,
): Promise<{ info: CertInfo | null; problems: string[]; sealed: number }> {
  const row = await loadAccount(admin, orgId, "document_seal");
  const { count } = await admin
    .from("fin_sealed_documents")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  if (!row) return { info: null, problems: [], sealed: count ?? 0 };
  const secrets = readSecrets(row);
  if (!secrets.certificate || !secrets.passphrase)
    return { info: null, problems: [], sealed: count ?? 0 };
  const check = checkSealSecrets(secrets, new Date());
  return {
    info: check.info,
    problems: check.ok ? [] : check.problems,
    sealed: count ?? 0,
  };
}
