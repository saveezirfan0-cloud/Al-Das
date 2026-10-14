import { createECDH } from "node:crypto";

/**
 * VAPID application server keys (RFC 8292): an ECDH P-256 key pair, both halves base64url without padding.
 * The public key is the uncompressed point (65 bytes); the private key is the raw scalar (32 bytes). This is the
 * same format `web-push generate-vapid-keys` prints, so the two are interchangeable.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    // getPrivateKey() drops leading zero bytes (about 1 key in 256 comes back 31 bytes); VAPID needs exactly 32.
    privateKey: leftPad(ecdh.getPrivateKey(), 32).toString("base64url"),
  };
}

function leftPad(buf: Buffer, size: number): Buffer {
  if (buf.length >= size) return buf;
  return Buffer.concat([Buffer.alloc(size - buf.length), buf]);
}
