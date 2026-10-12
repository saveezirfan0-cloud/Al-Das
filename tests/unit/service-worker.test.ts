/**
 * public/sw.js is plain browser JavaScript, so it is loaded into a Node `vm` context with a fake worker scope.
 * This checks the logic (what it caches, what it refuses to touch, what a push shows, where a tap goes). It does
 * NOT prove it works in a real browser: that needs a device, and is listed as not verified in docs/13.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(
  opts: { windows?: Array<{ url: string; visibilityState: string; focused: boolean }> } = {},
) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, unknown>>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const focused: string[] = [];
  const navigated: string[] = [];
  const opened: string[] = [];
  const windows = (opts.windows ?? []).map((w) => ({
    ...w,
    focus: async () => void focused.push(w.url),
    navigate: async (u: string) => void navigated.push(u),
  }));

  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (req: { url?: string } | string) =>
        m.get(typeof req === "string" ? req : (req.url as string)),
      put: async (req: { url: string }, res: unknown) => void m.set(req.url, res),
      addAll: async (urls: string[]) => void urls.forEach((u) => m.set(u, { cached: u })),
    };
  };
  const caches = {
    open: async (n: string) => cacheFor(n),
    match: async (req: string) => {
      for (const m of stores.values()) if (m.has(req)) return m.get(req);
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const self = {
    location: { origin: "https://pulse.test" },
    addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (u: string) => void opened.push(u),
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) =>
        void shown.push({ title, options }),
    },
  };
  const fetchMock = vi.fn(async (req: { url: string }) => ({
    ok: true,
    clone: () => ({ cloned: req.url }),
    body: req.url,
  }));
  const context = vm.createContext({
    self,
    caches,
    fetch: fetchMock,
    URL,
    Response: class {
      constructor(
        public body: string,
        public init?: unknown,
      ) {}
    },
    console,
  });
  vm.runInContext(readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8"), context);
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({
      ...event,
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
      respondWith: (p: Promise<unknown>) =>
        void waits.push(Promise.resolve(p).then((v) => ((event as { _res?: unknown })._res = v))),
    });
    await Promise.all(waits);
  };
  return { fire, self, stores, shown, focused, navigated, opened, fetchMock, caches, listeners };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });

describe("service worker: push", () => {
  it("shows the generic notification with the page to open", async () => {
    const w = loadWorker();
    await w.fire(
      "push",
      pushEvent({
        v: 1,
        event: "inbox.message",
        title: "New message",
        body: "A patient replied.",
        url: "/inbox?c=abc",
        tag: "inbox.message:abc",
      }),
    );
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe("New message");
    expect(w.shown[0].options).toMatchObject({
      body: "A patient replied.",
      tag: "inbox.message:abc",
      data: { url: "/inbox?c=abc" },
      renotify: false,
    });
  });

  it("falls back to safe defaults for a malformed payload and never opens an off-site URL", async () => {
    const w = loadWorker();
    await w.fire("push", {
      data: {
        json: () => {
          throw new Error("not json");
        },
      },
    });
    await w.fire("push", pushEvent({ title: "x", url: "https://evil.example/phish" }));
    await w.fire("push", pushEvent({ title: "x", url: "//evil.example" }));
    expect(w.shown.map((s) => (s.options.data as { url: string }).url)).toEqual([
      "/notifications",
      "/notifications",
      "/notifications",
    ]);
    expect(w.shown[0].title).toBe("Pulse");
  });

  it("stays quiet when Pulse is open and in front (the in-app toast covers it), except for the test button", async () => {
    const w = loadWorker({
      windows: [{ url: "https://pulse.test/inbox", visibilityState: "visible", focused: true }],
    });
    await w.fire(
      "push",
      pushEvent({ event: "inbox.message", title: "New message", body: "b", url: "/inbox" }),
    );
    expect(w.shown).toHaveLength(0);
    await w.fire(
      "push",
      pushEvent({
        event: "test",
        title: "Test notification",
        body: "b",
        url: "/settings/notifications",
      }),
    );
    expect(w.shown).toHaveLength(1);
  });

  it("still shows it when Pulse is open but in the background", async () => {
    const w = loadWorker({
      windows: [{ url: "https://pulse.test/inbox", visibilityState: "hidden", focused: false }],
    });
    await w.fire(
      "push",
      pushEvent({ event: "task.due", title: "Task due", body: "b", url: "/tasks" }),
    );
    expect(w.shown).toHaveLength(1);
  });
});

describe("service worker: tapping a notification", () => {
  const click = (url: unknown) => ({ notification: { data: { url }, close: vi.fn() } });

  it("focuses an open Pulse window and sends it to the page", async () => {
    const w = loadWorker({
      windows: [{ url: "https://pulse.test/dashboard", visibilityState: "hidden", focused: false }],
    });
    await w.fire("notificationclick", click("/tasks"));
    expect(w.focused).toEqual(["https://pulse.test/dashboard"]);
    expect(w.navigated).toEqual(["/tasks"]);
    expect(w.opened).toEqual([]);
  });

  it("opens a window when none is open, and refuses a URL that is not a same-origin path", async () => {
    const w = loadWorker();
    await w.fire("notificationclick", click("/inbox?c=1"));
    await w.fire("notificationclick", click("https://evil.example"));
    await w.fire("notificationclick", click(undefined));
    expect(w.opened).toEqual(["/inbox?c=1", "/notifications", "/notifications"]);
  });
});

describe("service worker: caching and the offline page", () => {
  it("precaches the offline page and does not take over until the user accepts the update", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    expect(w.stores.get("pulse-sw-v1-shell")?.has("/offline.html")).toBe(true);
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    await w.fire("message", { data: { type: "SKIP_WAITING" } });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
    await w.fire("message", { data: { type: "SOMETHING_ELSE" } });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("deletes caches from an older version when it activates", async () => {
    const w = loadWorker();
    await w.caches.open("pulse-sw-v0-static");
    await w.caches.open("some-other-app");
    await w.fire("activate", {});
    expect([...w.stores.keys()]).toEqual(["some-other-app"]);
  });

  it("serves build assets cache first, and caches them once", async () => {
    const w = loadWorker();
    const req = {
      method: "GET",
      mode: "no-cors",
      url: "https://pulse.test/_next/static/chunks/app.js",
    };
    const first = { respond: undefined as unknown, _res: undefined as unknown, request: req };
    await w.fire("fetch", first);
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
    await w.fire("fetch", { request: req });
    expect(w.fetchMock).toHaveBeenCalledTimes(1); // second time from the cache
  });

  it("never touches writes, other origins, API calls or pages that are not navigations", async () => {
    const w = loadWorker();
    for (const request of [
      { method: "POST", mode: "cors", url: "https://pulse.test/inbox" },
      { method: "GET", mode: "cors", url: "https://abc.supabase.co/rest/v1/contacts" },
      { method: "GET", mode: "cors", url: "https://pulse.test/api/contacts/export" },
      { method: "GET", mode: "same-origin", url: "https://pulse.test/inbox?_rsc=1" },
    ]) {
      const respond = vi.fn();
      w.listeners.get("fetch")!({ request, respondWith: respond });
      expect(respond, `${request.method} ${request.url}`).not.toHaveBeenCalled();
    }
  });

  it("shows the offline page when a navigation cannot reach the network, and never caches the page itself", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    w.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const event: Record<string, unknown> = {
      request: { method: "GET", mode: "navigate", url: "https://pulse.test/inbox" },
    };
    await w.fire("fetch", event);
    expect(event._res).toEqual({ cached: "/offline.html" });
    const cached = [...w.stores.values()].flatMap((m) => [...m.keys()]);
    expect(cached).not.toContain("https://pulse.test/inbox");
  });
});
