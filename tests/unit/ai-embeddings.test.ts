import { describe, expect, it, vi } from "vitest";

import {
  createFakeEmbedder,
  createVoyageEmbedder,
  EMBEDDING_DIMENSIONS,
  EmbeddingsError,
  toVectorLiteral,
} from "@/lib/ai/embeddings";
import { selectPassages } from "@/lib/ai/kb";

const vector = () => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5);

function voyageResponse(n: number, offset = 0, reverse = false) {
  const data = Array.from({ length: n }, (_, i) => ({ index: i + offset, embedding: vector() }));
  if (reverse) data.reverse();
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe("createVoyageEmbedder", () => {
  it("batches in 64s, sends the input type and bearer key, and restores order", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return voyageResponse(body.input.length, 0, true); // server returns out of order
    });
    const e = createVoyageEmbedder({ apiKey: "k", model: "voyage-3", fetchImpl: fetchImpl as never });
    const out = await e.embed(Array.from({ length: 130 }, (_, i) => `t${i}`), "document");

    expect(out).toHaveLength(130);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 64 + 64 + 2
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "voyage-3", input_type: "document" });
  });

  it("uses input_type query for queries", async () => {
    const fetchImpl = vi.fn(async () => voyageResponse(1));
    await createVoyageEmbedder({ apiKey: "k", fetchImpl: fetchImpl as never }).embed(["q"], "query");
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).input_type).toBe("query");
  });

  it("rejects a model that does not return 1024 dimensions", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] })));
    await expect(createVoyageEmbedder({ apiKey: "k", fetchImpl: fetchImpl as never }).embed(["a"], "query")).rejects.toThrow(
      /1024-dimension/,
    );
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
    [401, false],
  ])("marks HTTP %i retryable=%s and never leaks the body", async (status, retryable) => {
    const fetchImpl = vi.fn(async () => new Response("secret document text echoed back", { status }));
    const err = await createVoyageEmbedder({ apiKey: "k", fetchImpl: fetchImpl as never })
      .embed(["a"], "document")
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingsError);
    expect(err.retryable).toBe(retryable);
    expect(err.message).not.toContain("secret document text");
  });

  it("treats a network failure as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await createVoyageEmbedder({ apiKey: "k", fetchImpl: fetchImpl as never }).embed(["a"], "query").catch((e) => e);
    expect(err.retryable).toBe(true);
  });
});

describe("createFakeEmbedder", () => {
  const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

  it("returns unit vectors of the right size, deterministically", async () => {
    const e = createFakeEmbedder();
    const [a, a2] = [(await e.embed(["opening hours"], "document"))[0], (await e.embed(["opening hours"], "query"))[0]];
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(a2);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
  });

  it("has a lower cutoff than a real model because bag-of-words scores are lower", () => {
    expect(createFakeEmbedder().minSimilarity).toBeLessThan(createVoyageEmbedder({ apiKey: "k" }).minSimilarity);
  });

  it("ranks texts that share words above unrelated ones", async () => {
    const e = createFakeEmbedder();
    const [q, hours, parking] = await e.embed(
      ["what are your opening hours", "our opening hours are 8am to 8pm", "parking is free behind the building"],
      "document",
    );
    expect(cosine(q, hours)).toBeGreaterThan(cosine(q, parking));
  });
});

describe("toVectorLiteral / selectPassages", () => {
  it("formats a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0, 1])).toBe("[0.1,0,1]");
  });

  it("drops weak matches and maps rows to passages", () => {
    const rows = [
      { chunk_id: "a", source_id: "s", source_name: "Hours", content: "x", similarity: 0.82 },
      { chunk_id: "b", source_id: "s", source_name: "Hours", content: "y", similarity: 0.12 },
    ];
    expect(selectPassages(rows)).toEqual([{ chunkId: "a", sourceId: "s", sourceName: "Hours", content: "x", similarity: 0.82 }]);
    expect(selectPassages(rows, 0.1)).toHaveLength(2);
  });
});
