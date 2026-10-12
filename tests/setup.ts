import { config } from "dotenv";
import path from "node:path";

// Local overrides first, then the shared dev env. Neither is required for unit tests.
config({ path: path.resolve(process.cwd(), ".env.test.local"), override: false });
config({ path: path.resolve(process.cwd(), ".env.local"), override: false });

// The Unite Finance API is deliver-once and live (CLAUDE.md rule 7): no test may ever reach it.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/uniteuae\.care/i.test(url)) throw new Error("Tests must never call the real Unite API");
  // Phase 17: the AI features are tested with a fake model behind the Llm interface; no test may reach a provider.
  if (/^https?:\/\/([a-z0-9-]+\.)*(anthropic\.com|voyageai\.com|graph\.facebook\.com)([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call an AI provider or Meta: use a fake client");
  return realFetch(input, init);
}) as typeof fetch;
