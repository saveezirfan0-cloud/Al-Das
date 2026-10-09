/**
 * Knowledge-base retrieval path against real Postgres + pgvector: chunk → embed (deterministic fake
 * embedder) → kb_replace_chunks → kb_match, using the same vector literal format the app sends.
 * Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeEmbedder, toVectorLiteral } from "@/lib/ai/embeddings";
import { chunkText } from "@/lib/ai/ingest/chunk";
import { contentHash } from "@/lib/ai/ingest/extract";
import { selectPassages } from "@/lib/ai/kb";

import { asServiceRole, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const DOCS: Record<string, string> = {
  Hours:
    "Opening hours\n\nThe clinic is open from 8am to 8pm, Saturday to Thursday. We are closed on Fridays.\n\nThe pharmacy opens at 9am.",
  Fees: "Consultation fees\n\nA general practitioner consultation costs 250 dirhams. A specialist consultation costs 450 dirhams.",
  Parking: "Parking\n\nFree parking is available behind the building for all patients.",
};

describe.skipIf(!TEST_DATABASE_URL)("knowledge base retrieval", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const embedder = createFakeEmbedder();

  async function ingest(org: string, name: string, text: string) {
    const { rows } = await c.query<{ id: string }>(
      "insert into public.kb_sources (org_id, kind, name, url, status) values ($1, 'url', $2, $3, 'processing') returning id",
      [org, name, `https://example.test/${name.toLowerCase()}`],
    );
    const chunks = chunkText(text);
    const vectors = await embedder.embed(chunks, "document");
    await c.query("select public.kb_replace_chunks($1, $2, $3::jsonb, $4)", [
      org,
      rows[0].id,
      JSON.stringify(chunks.map((content, ord) => ({ ord, content, embedding: vectors[ord] }))),
      contentHash(text),
    ]);
    return rows[0].id;
  }

  async function search(org: string, question: string) {
    const [q] = await embedder.embed([question], "query");
    const { rows } = await c.query(
      "select chunk_id, source_id, source_name, content, similarity from public.kb_match($1, $2::vector, null, 5)",
      [org, toVectorLiteral(q)],
    );
    return selectPassages(rows, embedder.minSimilarity);
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      for (const [name, text] of Object.entries(DOCS)) await ingest(orgA, name, text);
      await ingest(orgB, "Hours", "Opening hours: Org B is open from 6am to 2am every day.");
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("returns the passage that answers the question first", async () => {
    await asServiceRole(c, async () => {
      const hours = await search(orgA, "what are your opening hours");
      expect(hours[0].sourceName).toBe("Hours");
      expect(hours[0].content).toMatch(/8am to 8pm/);

      const fees = await search(orgA, "how much does a specialist consultation cost");
      expect(fees[0].sourceName).toBe("Fees");

      const parking = await search(orgA, "is there free parking");
      expect(parking[0].sourceName).toBe("Parking");
    });
  });

  it("never returns another org's passages", async () => {
    await asServiceRole(c, async () => {
      const a = await search(orgA, "opening hours");
      expect(a.every((p) => !p.content.includes("Org B"))).toBe(true);
      const b = await search(orgB, "opening hours");
      expect(b).toHaveLength(1);
      expect(b[0].content).toMatch(/Org B/);
    });
  });

  it("returns nothing for an unrelated question once weak matches are dropped", async () => {
    await asServiceRole(c, async () => {
      expect(await search(orgA, "quantum chromodynamics lattice gauge")).toEqual([]);
    });
  });

  it("re-ingesting a source replaces its sections instead of duplicating them", async () => {
    await asServiceRole(c, async () => {
      const id = await ingest(orgA, "Parking v2", "Parking is now paid after 6pm.");
      await ingest(orgA, "Parking v2 again", "Different source, same org.");
      const before = await c.query("select count(*)::int as n from public.kb_chunks where source_id = $1", [id]);
      const text = "Parking is now paid after 6pm.\n\nValet service is available.";
      const chunks = chunkText(text);
      const vectors = await embedder.embed(chunks, "document");
      await c.query("select public.kb_replace_chunks($1, $2, $3::jsonb, $4)", [
        orgA,
        id,
        JSON.stringify(chunks.map((content, ord) => ({ ord, content, embedding: vectors[ord] }))),
        contentHash(text),
      ]);
      const after = await c.query("select count(*)::int as n, min(content) as c from public.kb_chunks where source_id = $1", [id]);
      expect(before.rows[0].n).toBe(1);
      expect(after.rows[0].n).toBe(1); // the two paragraphs fit in one chunk; the old one is gone
      expect(after.rows[0].c).toMatch(/Valet/);
    });
  });
});
