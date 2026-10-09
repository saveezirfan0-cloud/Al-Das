import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (Meta tokens, integration credentials).
 * Format: v1:<iv>:<tag>:<ciphertext>, all base64. The key is ENCRYPTION_KEY,
 * 32 random bytes base64-encoded (`openssl rand -base64 32`).
 */

const VERSION = "v1";

export function loadEncryptionKey(raw = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export function encryptSecret(plain: string, key: Buffer = loadEncryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(blob: string, key: Buffer = loadEncryptionKey()): string {
  const [version, ivB64, tagB64, dataB64] = blob.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

/** Last 4 characters only, for logs and the UI. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  return `••••${value.slice(-4)}`;
}

/** JSON convenience wrappers (integration credentials). */
export function encryptJson(value: unknown, key?: Buffer): string {
  return encryptSecret(JSON.stringify(value), key);
}

export function decryptJson<T>(blob: string, key?: Buffer): T {
  return JSON.parse(decryptSecret(blob, key)) as T;
}
