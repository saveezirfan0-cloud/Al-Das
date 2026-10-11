import { expect, test } from "@playwright/test";

// These requests are rejected before any database access, so they run without a Supabase stack.

test("public API routes demand a bearer key", async ({ request }) => {
  for (const [method, path] of [
    ["GET", "/api/public/v1/contacts"],
    ["POST", "/api/public/v1/contacts"],
    ["GET", "/api/public/v1/contacts/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"],
    ["GET", "/api/public/v1/enquiries"],
    ["GET", "/api/public/v1/enquiries/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"],
    ["GET", "/api/public/v1/tasks"],
    ["GET", "/api/public/v1/tasks/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"],
    ["GET", "/api/public/v1/appointments"],
    ["GET", "/api/public/v1/appointments/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"],
    ["POST", "/api/public/v1/send-template"],
  ] as const) {
    const res = await request.fetch(path, { method, maxRedirects: 0 });
    expect(res.status(), `${method} ${path}`).toBe(401);
    expect(res.headers()["www-authenticate"]).toMatch(/Bearer/);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "missing_api_key", message: expect.any(String) } });
  }
});

test("a malformed key is rejected without revealing why", async ({ request }) => {
  const res = await request.get("/api/public/v1/contacts", { headers: { Authorization: "Bearer not-a-real-key" } });
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("invalid_api_key");
});
