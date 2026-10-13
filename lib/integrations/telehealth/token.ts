import { createHash, randomBytes } from "node:crypto";

/** A room token: 256 random bits as base64url (43 characters, safe in a URL path and as a room name). */
export function newRoomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRoomToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
