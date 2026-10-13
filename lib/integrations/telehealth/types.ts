/** A video-room provider. Static URL templates make no network call; API providers go through the shared integration client. */
export type RoomRequest = {
  /** The unguessable token, used as the room's name. It never contains a patient name or id. */
  roomName: string;
  /** The room stops working after this moment (providers that can enforce it do). */
  expiresAt: Date;
  /** The room does not open before this moment (providers that can enforce it do). */
  notBefore: Date;
};

export type RoomResult =
  | { ok: true; roomRef: string | null; url: string }
  | { ok: false; code: string; retryable: boolean };

export interface TelehealthProvider {
  readonly id: "static" | "daily" | "fake";
  createRoom(r: RoomRequest): Promise<RoomResult>;
  /** Removes the room at the provider. True when it is gone (or was never there). */
  deleteRoom(roomRef: string): Promise<boolean>;
  verify?(): Promise<{ ok: boolean; code?: string }>;
}
