import { beforeEach, describe, expect, it, vi } from "vitest";

import { signMetaPayload } from "@/lib/whatsapp/signature";

const insert = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
    from: () => ({ insert: (row: unknown) => ({ select: () => ({ single: () => insert(row) }) }) }),
  }),
}));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

const SECRET = "test-app-secret";
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

async function post(raw: string, headers: Record<string, string> = {}) {
  const { POST, MAX_WEBHOOK_BYTES } = await import("@/app/api/webhooks/meta/route");
  const req = new Request("http://localhost/api/webhooks/meta", { method: "POST", body: raw, headers });
  return { res: await POST(req as never), MAX_WEBHOOK_BYTES };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.JOB_SECRET = "j".repeat(24);
  process.env.META_APP_SECRET = SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-me";
  insert.mockResolvedValue({ data: { id: "evt-1" }, error: null });
  rpc.mockResolvedValue({ data: [{ allowed: true, hits: 1, retry_after: 0 }], error: null });
  enqueue.mockResolvedValue(undefined);
});

describe("POST /api/webhooks/meta", () => {
  it("rejects a missing signature with 401 and stores nothing", async () => {
    const { res } = await post(body);
    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a wrong or truncated signature", async () => {
    expect((await post(body, { "x-hub-signature-256": signMetaPayload(body, "other-secret") })).res.status).toBe(401);
    expect((await post(body, { "x-hub-signature-256": "sha256=abc" })).res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a signature computed over a different body (raw bytes are what count)", async () => {
    const sig = signMetaPayload(body, SECRET);
    expect((await post(body + " ", { "x-hub-signature-256": sig })).res.status).toBe(401);
  });

  it("answers 429 once bad-signature attempts exceed the limit", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, hits: 31, retry_after: 20 }], error: null });
    const { res } = await post(body, { "x-hub-signature-256": "sha256=bad" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("20");
  });

  it("never rate-limits a validly signed request", async () => {
    const { res } = await post(body, { "x-hub-signature-256": signMetaPayload(body, SECRET) });
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stores the raw payload, enqueues once and returns 200 fast", async () => {
    const { res } = await post(body, { "x-hub-signature-256": signMetaPayload(body, SECRET) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "evt-1" });
    expect(insert).toHaveBeenCalledWith({ source: "meta", payload: JSON.parse(body) });
    expect(enqueue).toHaveBeenCalledWith("meta_events", { event_id: "evt-1" });
  });

  it("still answers 200 when the enqueue fails (the sweep re-queues the stored row)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.mockRejectedValue(new Error("pgmq down"));
    const { res } = await post(body, { "x-hub-signature-256": signMetaPayload(body, SECRET) });
    expect(res.status).toBe(200);
    err.mockRestore();
  });

  it("answers 500 (so Meta retries) when the row cannot be stored", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ data: null, error: { code: "XX000" } });
    const { res } = await post(body, { "x-hub-signature-256": signMetaPayload(body, SECRET) });
    expect(res.status).toBe(500);
    expect(enqueue).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("returns 400 for a validly signed non-JSON body", async () => {
    const raw = "not json";
    expect((await post(raw, { "x-hub-signature-256": signMetaPayload(raw, SECRET) })).res.status).toBe(400);
  });

  it("returns 413 for oversized bodies before verifying anything", async () => {
    const { MAX_WEBHOOK_BYTES } = await import("@/app/api/webhooks/meta/route");
    const huge = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    expect((await post(huge, { "x-hub-signature-256": signMetaPayload(huge, SECRET) })).res.status).toBe(413);
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 503 when the app secret is not configured", async () => {
    delete process.env.META_APP_SECRET;
    expect((await post(body)).res.status).toBe(503);
  });
});

describe("GET /api/webhooks/meta (verification handshake)", () => {
  async function get(qs: string) {
    const { GET } = await import("@/app/api/webhooks/meta/route");
    const url = new URL(`http://localhost/api/webhooks/meta?${qs}`);
    return GET({ nextUrl: url } as never);
  }
  it("echoes the challenge only for the right verify token", async () => {
    const ok = await get("hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    expect((await get("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
    expect((await get("hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=1")).status).toBe(403);
  });
});
