import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn();
vi.mock("@/lib/whatsapp/sync", () => ({
  syncTemplatesForChannel: (...a: unknown[]) => sync(...a),
}));

import "@/lib/jobs/handlers/templates-sync";
import { getTask } from "@/lib/jobs/tasks";

import { fakeAdmin, fakeDb } from "./helpers/fake-admin";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("templates_sync task", () => {
  beforeEach(() => {
    sync.mockReset();
    log.warn.mockReset();
  });

  it("is registered", () => {
    expect(getTask("templates_sync")?.name).toBe("templates.nightly_sync");
  });

  it("syncs every active channel and keeps going when one fails (errors redacted)", async () => {
    const db = fakeDb({
      channels: [
        { id: "c1", org_id: "o", phone_number_id: "1", waba_id: "W1", status: "active" },
        { id: "c2", org_id: "o", phone_number_id: "2", waba_id: "W2", status: "active" },
        { id: "c3", org_id: "o", phone_number_id: "3", waba_id: "W3", status: "paused" },
      ],
    });
    sync.mockResolvedValueOnce({ synced: 5, removed: 1 });
    sync.mockRejectedValueOnce(
      new Error("token EAAG" + "x".repeat(40) + " expired for +971501234567"),
    );
    const result = (await getTask("templates_sync")!.run(fakeAdmin(db), log)) as Record<
      string,
      unknown
    >;
    expect(sync).toHaveBeenCalledTimes(2); // the paused channel is skipped
    expect(result).toMatchObject({ channels: 2, synced: 5, removed: 1, failed: 1 });
    const text = JSON.stringify(result);
    expect(text).not.toContain("EAAG");
    expect(text).not.toContain("971501234567");
  });
});
