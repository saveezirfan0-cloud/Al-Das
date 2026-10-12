import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearScanProviders,
  isServable,
  NoopScanner,
  registerScanProvider,
  resolveScanner,
  runScan,
  scanBadge,
  type MalwareScanner,
  type ScanTarget,
} from "@/lib/media/scan";
import { probeObject, removeObjects, type StorageHost } from "@/lib/media/probe";

const target: ScanTarget = {
  bucket: "patient-documents",
  path: "p",
  size: 3,
  mime: "application/pdf",
  open: async () => new Blob([new Uint8Array([1, 2, 3])]),
};

describe("malware scan hook", () => {
  beforeEach(() => clearScanProviders());

  it("uses the no-op scanner by default and it says 'unscanned', never 'clean'", async () => {
    const s = resolveScanner(undefined);
    expect(s).toBeInstanceOf(NoopScanner);
    expect(await runScan(s, target)).toEqual({ verdict: "unscanned", engine: "none" });
  });

  it("falls back to the no-op scanner for an unknown provider name (fail safe: still flagged)", async () => {
    expect(resolveScanner("nonexistent")).toBeInstanceOf(NoopScanner);
  });

  it("uses a registered provider by name", async () => {
    const provider: MalwareScanner = {
      name: "fake",
      scan: async () => ({ verdict: "clean", engine: "fake" }),
    };
    registerScanProvider("Fake", () => provider);
    expect(resolveScanner(" fake ")).toBe(provider);
    expect((await runScan(resolveScanner("fake"), target)).verdict).toBe("clean");
  });

  it("turns a provider that throws, or lies, into 'error' rather than 'clean'", async () => {
    const boom: MalwareScanner = {
      name: "boom",
      scan: async () => {
        throw new Error("down");
      },
    };
    expect((await runScan(boom, target)).verdict).toBe("error");
    const liar = { name: "liar", scan: async () => ({ verdict: "fine" as never, engine: "liar" }) };
    expect((await runScan(liar, target)).verdict).toBe("error");
  });

  it("flags unscanned files in the UI and blocks only infected ones", () => {
    expect(scanBadge("unscanned")).toMatchObject({ tone: "warn", label: "Not scanned" });
    expect(scanBadge(null).tone).toBe("warn");
    expect(scanBadge("error").tone).toBe("warn");
    expect(scanBadge("clean").tone).toBe("ok");
    expect(scanBadge("infected").tone).toBe("danger");
    expect(isServable("infected")).toBe(false);
    expect(["unscanned", "clean", "error", null].every((s) => isServable(s))).toBe(true);
  });
});

function fakeHost(opts: {
  info?: { size?: number; contentType?: string } | null;
  signed?: string | null;
  removeError?: boolean;
}): StorageHost & { removed: string[][] } {
  const removed: string[][] = [];
  return {
    removed,
    storage: {
      from: () => ({
        info: async () => ({
          data: opts.info ?? null,
          error: opts.info ? null : { message: "nope" },
        }),
        createSignedUrl: async () => ({
          data:
            opts.signed === null
              ? null
              : { signedUrl: opts.signed ?? "https://storage.example.test/signed" },
          error: null,
        }),
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: opts.removeError ? { message: "x" } : null };
        },
      }),
    },
  };
}

describe("probeObject", () => {
  it("returns the real size and the first bytes through a ranged read", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Range).toBe("bytes=0-63");
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 206 });
    });
    const r = await probeObject(
      fakeHost({ info: { size: 99, contentType: "application/pdf" } }),
      "b",
      "p",
      fetchImpl as never,
    );
    expect(r?.size).toBe(99);
    expect(Array.from(r!.head)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it("reads only the head when the server ignores Range and sends everything", async () => {
    const big = new Uint8Array(10_000).fill(7);
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
    const r = await probeObject(fakeHost({ info: { size: 10_000 } }), "b", "p", fetchImpl as never);
    expect(r?.head.length).toBe(64);
  });

  it("returns null when the object is missing or cannot be read", async () => {
    expect(await probeObject(fakeHost({ info: null }), "b", "p", vi.fn() as never)).toBeNull();
    expect(
      await probeObject(fakeHost({ info: { size: 5 }, signed: null }), "b", "p", vi.fn() as never),
    ).toBeNull();
    const notFound = vi.fn(async () => new Response("", { status: 404 }));
    expect(
      await probeObject(fakeHost({ info: { size: 5 } }), "b", "p", notFound as never),
    ).toBeNull();
  });
});

describe("removeObjects", () => {
  it("removes in batches of 100 and reports failure", async () => {
    const host = fakeHost({});
    const paths = Array.from({ length: 230 }, (_, i) => `p${i}`);
    expect(await removeObjects(host, "b", paths)).toBe(true);
    expect(host.removed.map((b) => b.length)).toEqual([100, 100, 30]);
    expect(await removeObjects(fakeHost({ removeError: true }), "b", ["a"])).toBe(false);
    expect(await removeObjects(host, "b", [])).toBe(true);
  });
});
