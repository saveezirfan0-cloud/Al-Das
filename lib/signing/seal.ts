import { openP12, p12FromBase64, SigningError, type SigningIdentity } from "@/lib/signing/p12";
import { certificateProblems, type CertInfo } from "@/lib/signing/x509";

/**
 * The organisation seal's certificate, from the integration's decrypted secret fields (pure: no database). Used by the
 * readiness check (Settings, Integrations), by the save action (a wrong password is refused at once) and by the server
 * code that seals. The messages never contain the certificate, its password or the key.
 */

export type SealSecrets = { certificate?: string; passphrase?: string };

export type SealCheck =
  | { ok: true; identity: SigningIdentity; info: CertInfo }
  | { ok: false; problems: string[]; info: CertInfo | null };

export function checkSealSecrets(secrets: SealSecrets, now: Date): SealCheck {
  if (!secrets.certificate)
    return { ok: false, problems: ["Certificate file is missing."], info: null };
  if (!secrets.passphrase)
    return { ok: false, problems: ["Certificate password is missing."], info: null };
  let identity: SigningIdentity;
  try {
    identity = openP12(p12FromBase64(secrets.certificate), secrets.passphrase);
  } catch (err) {
    const msg =
      err instanceof SigningError
        ? err.code === "wrong_pin"
          ? "The certificate password is not correct."
          : err.message
        : "The certificate file cannot be read.";
    return { ok: false, problems: [msg], info: null };
  }
  const problems = certificateProblems(identity.info, now);
  if (problems.length > 0) return { ok: false, problems, info: identity.info };
  return { ok: true, identity, info: identity.info };
}

/** The seal's visible settings, with the catalogue's defaults. */
export function sealConfig(config: Record<string, unknown>): {
  name: string;
  reason: string;
  location: string;
} {
  const s = (k: string, d: string) => {
    const v = config[k];
    return typeof v === "string" && v.trim() ? v.trim() : d;
  };
  return {
    name: s("seal_name", "Organisation seal"),
    reason: s("reason", "Approved and recorded in Pulse"),
    location: s("location", "Dubai, United Arab Emirates"),
  };
}
