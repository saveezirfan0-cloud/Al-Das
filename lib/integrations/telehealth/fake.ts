import type {
  RoomRequest,
  RoomResult,
  TelehealthProvider,
} from "@/lib/integrations/telehealth/types";

/** An in-memory provider for tests: records the rooms it was asked for and can be told to fail. Never touches the network. */
export function createFakeTelehealthProvider(
  script: { failCreate?: { code: string; retryable: boolean }; failDelete?: boolean } = {},
): TelehealthProvider & { created: RoomRequest[]; deleted: string[] } {
  const created: RoomRequest[] = [];
  const deleted: string[] = [];
  return {
    id: "fake",
    created,
    deleted,
    async createRoom(r): Promise<RoomResult> {
      if (script.failCreate) return { ok: false, ...script.failCreate };
      created.push(r);
      return { ok: true, roomRef: r.roomName, url: `https://video.fake.test/${r.roomName}` };
    },
    async deleteRoom(ref) {
      if (script.failDelete) return false;
      deleted.push(ref);
      return true;
    },
    async verify() {
      return { ok: true };
    },
  };
}
