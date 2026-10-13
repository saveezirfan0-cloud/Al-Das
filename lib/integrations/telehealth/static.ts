import { buildRoomUrl, validateRoomTemplate } from "@/lib/integrations/telehealth/url";
import type { TelehealthProvider } from "@/lib/integrations/telehealth/types";

/**
 * The generic provider: the clinic's own meeting service addressed by a URL template such as https://meet.example.com/{token}. Pulse
 * makes no call to it, so it cannot create, expire or remove a room: the unguessable token in the address is the only protection, and
 * Pulse stops giving the address out once the visit window has passed.
 */
export function createStaticProvider(urlTemplate: string): TelehealthProvider | null {
  if (!validateRoomTemplate(urlTemplate).ok) return null;
  return {
    id: "static",
    async createRoom(r) {
      const url = buildRoomUrl(urlTemplate, r.roomName);
      return url
        ? { ok: true, roomRef: null, url }
        : { ok: false, code: "bad_template", retryable: false };
    },
    async deleteRoom() {
      return true;
    },
    async verify() {
      return validateRoomTemplate(urlTemplate).ok
        ? { ok: true }
        : { ok: false, code: "bad_template" };
    },
  };
}
