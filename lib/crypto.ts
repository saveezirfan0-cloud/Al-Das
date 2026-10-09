import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (CLAUDE.md rule 9). Format:
 *   v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>
 * The key is ENCRYPTION_KEY: 32 random bytes, base64 (`openssl rand -base64 32`).
 * Never log plaintext, keys or decrypted configs.
 */
const VERSION = "v1";

function keyFrom(base64Key: string | undefined): Buffer {
  const key = Buffer.from(base64Key ?? "", "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return key;
}

export function encryptSecret(plaintext: string, base64Key = process.env.ENCRYPTION_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, base64Key = process.env.ENCRYPTION_KEY): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined)
    throw new Error("unsupported secret format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFrom(base64Key),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("could not decrypt secret (wrong key or corrupted data)");
  }
}

export function encryptJson(value: unknown, base64Key?: string): string {
  return encryptSecret(JSON.stringify(value), base64Key);
}

export function decryptJson<T>(payload: string, base64Key?: string): T {
  return JSON.parse(decryptSecret(payload, base64Key)) as T;
}
