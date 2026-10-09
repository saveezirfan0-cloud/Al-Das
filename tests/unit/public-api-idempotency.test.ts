import { describe, expect, it } from "vitest";

import { beginIdempotent, canonicalJson, completeIdempotent, hashRequest, releaseIdempotent } from "@/lib/public-api/idempotency";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

describe("request hashing", () => {
  it("ignores key order but not values", () => {
    expect(hashRequest({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(hashRequest({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: [1, 2] })).not.toBe(hashRequest({ a: [2, 1] }));
    expect(canonicalJson({ b: undefined, a: null })).toBe('{"a":null,"b":null}');
  });
});

describe("idempotency lifecycle", () => {
  const setup = () => {
    const admin = createFakeAdmin({}, { unique: { api_idempotency: [["api_key_id", "idempotency_key"]] }, defaults: { api_idempotency: () => ({ response_status: null, response: null }) } });
    return { admin, as: admin as unknown as AdminClient };
  };
  const req = (over: Partial<{ keyId: string; idempotencyKey: string; requestHash: string }> = {}) => ({ orgId: "org1", keyId: "k1", idempotencyKey: "abc", requestHash: "h1", ...over });

  it("lets the first request proceed, replays the stored success, and refuses a different body", async () => {
    const { as } = setup();
    const first = await beginIdempotent(as, req());
    expect(first.state).toBe("proceed");
    if (first.state !== "proceed") return;

    // a duplicate while the first is still running
    expect(await beginIdempotent(as, req())).toEqual({ state: "in_progress" });

    await completeIdempotent(as, first.id, 202, { message_id: "m1" });
    expect(await beginIdempotent(as, req())).toEqual({ state: "replay", status: 202, body: { message_id: "m1" } });
    // same key, different body
    expect(await beginIdempotent(as, req({ requestHash: "h2" }))).toEqual({ state: "mismatch" });
  });

  it("scopes keys per API key", async () => {
    const { as } = setup();
    expect((await beginIdempotent(as, req())).state).toBe("proceed");
    expect((await beginIdempotent(as, req({ keyId: "k2" }))).state).toBe("proceed");
  });

  it("releases a failed attempt so the same key can be retried", async () => {
    const { as } = setup();
    const first = await beginIdempotent(as, req());
    if (first.state !== "proceed") throw new Error("expected proceed");
    await releaseIdempotent(as, first.id);
    expect((await beginIdempotent(as, req())).state).toBe("proceed");
  });
});
