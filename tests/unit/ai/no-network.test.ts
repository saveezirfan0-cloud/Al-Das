import { describe, expect, it } from "vitest";

describe("the test environment", () => {
  it("refuses to reach an AI provider, the embeddings provider or Meta", () => {
    for (const url of [
      "https://api.anthropic.com/v1/messages",
      "https://api.voyageai.com/v1/embeddings",
      "https://graph.facebook.com/v21.0/123/messages",
    ])
      expect(() => fetch(url)).toThrow(/must never call/);
  });
});
