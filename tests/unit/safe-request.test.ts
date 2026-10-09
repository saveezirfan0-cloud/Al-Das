import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A scripted stand-in for node:https: the real module cannot reach localhost through our SSRF guard.
type FakeRes = EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> };
let script: (req: FakeReq, respond: (res: FakeRes) => void) => void;
type FakeReq = EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };

vi.mock("node:https", () => ({
  request: (_url: unknown, _opts: unknown, cb: (res: FakeRes) => void) => {
    const req = new EventEmitter() as FakeReq;
    req.write = vi.fn();
    req.end = vi.fn(() => script(req, cb));
    req.destroy = vi.fn((err?: Error) => {
      if (err) queueMicrotask(() => req.emit("error", err));
    });
    return req;
  },
}));

import { ResponseTooLargeError, safeRequest } from "@/lib/net/safe-request";

const res = (status = 200): FakeRes => Object.assign(new EventEmitter(), { statusCode: status, headers: { "content-type": "text/plain" }, destroy: vi.fn() }) as FakeRes;
const URL_ = "https://hooks.example.test/x";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("safeRequest", () => {
  it("returns status, lowercased headers and the body", async () => {
    script = (_req, respond) => {
      const r = res(201);
      respond(r);
      r.emit("data", Buffer.from("hel"));
      r.emit("data", Buffer.from("lo"));
      r.emit("end");
    };
    const out = await safeRequest(URL_);
    expect(out.status).toBe(201);
    expect(out.headers["content-type"]).toBe("text/plain");
    expect(out.body.toString()).toBe("hello");
  });

  it("refuses a non-https or private URL before any connection", async () => {
    script = () => {
      throw new Error("must not connect");
    };
    await expect(safeRequest("http://example.com")).rejects.toThrow(/https/);
    await expect(safeRequest("https://127.0.0.1/")).rejects.toThrow(/not publicly reachable/);
  });

  it("truncate mode returns the first maxBytes immediately and stops reading", async () => {
    const r = res(200);
    script = (_req, respond) => {
      respond(r);
      r.emit("data", Buffer.from("0123456789")); // 10 bytes, limit 4
    };
    const out = await safeRequest(URL_, { maxBytes: 4, onOverflow: "truncate" });
    expect(out.body.toString()).toBe("0123");
    expect(r.destroy).toHaveBeenCalledTimes(1);
    // a late chunk after settling is ignored and cannot throw
    expect(() => r.emit("data", Buffer.from("more"))).not.toThrow();
  });

  it("error mode aborts the request when the body is too large", async () => {
    let request!: FakeReq;
    script = (req, respond) => {
      request = req;
      const r = res(200);
      respond(r);
      r.emit("data", Buffer.alloc(100));
    };
    await expect(safeRequest(URL_, { maxBytes: 10 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(request.destroy).toHaveBeenCalled();
  });

  it("enforces an absolute deadline even when the server trickles data and the socket is never idle", async () => {
    let request!: FakeReq;
    script = (req, respond) => {
      request = req;
      const r = res(200);
      respond(r);
      // one byte every 5 s, forever: never trips an idle timeout
      const t = setInterval(() => r.emit("data", Buffer.from("x")), 5_000);
      req.once("error", () => clearInterval(t));
    };
    const p = safeRequest(URL_, { deadlineMs: 12_000, timeoutMs: 10_000 });
    const failure = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(12_001);
    await failure;
    expect(request.destroy).toHaveBeenCalled();
  });

  it("maps the idle socket timeout to a timeout error", async () => {
    script = (req) => {
      queueMicrotask(() => req.emit("timeout"));
    };
    await expect(safeRequest(URL_)).rejects.toThrow(/timed out/i);
  });

  it("follows redirects only when asked, re-validating every hop", async () => {
    let calls = 0;
    script = (_req, respond) => {
      calls++;
      const r = res(calls === 1 ? 302 : 200);
      if (calls === 1) r.headers.location = "https://169.254.169.254/latest/meta-data";
      respond(r);
      r.emit("end");
    };
    // not asked to follow: the 302 is returned as-is
    expect((await safeRequest(URL_)).status).toBe(302);
    calls = 0;
    // asked to follow, but the redirect target is a metadata address: refused, never connected to
    await expect(safeRequest(URL_, { maxRedirects: 3 })).rejects.toThrow(/not publicly reachable/);
    expect(calls).toBe(1);
  });
});
