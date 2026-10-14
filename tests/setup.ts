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
  // Phase 19: payment gateways and the SMS provider are tested with fake clients and recorded responses; no test may reach them.
  if (/^https?:\/\/([a-z0-9-]+\.)*(stripe\.com|paytabs\.com|paytabs\.sa|twilio\.com)([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call a payment gateway or an SMS provider: use a fake client");
  // Phase 19b: the video-room and e-signature providers are tested with fakes and recorded responses; no test may reach them.
  if (/^https?:\/\/([a-z0-9-]+\.)*(daily\.co|hellosign\.com|dropboxsign\.com)([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call a video or e-signature provider: use a fake client");
  // Phase 20e: Instagram / Messenger (graph.facebook.com is blocked above) and Google Calendar / OAuth are tested with fake fetches.
  if (/^https?:\/\/([a-z0-9-]+\.)*(instagram\.com|facebook\.com|messenger\.com|googleapis\.com|google\.com)([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call Instagram, Messenger or Google: use a fake fetch");
  // Phase G: outgoing e-mail (attachments included) is tested with a fake transport; no test may reach Resend.
  if (/^https?:\/\/([a-z0-9-]+\.)*resend\.(com|dev)([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call Resend: pass a fake EmailTransport");
  // Phase 20B: the finance mailbox is inbound only (the mail service posts to Pulse); no test may reach the mail service.
  if (/^https?:\/\/([a-z0-9-]+\.)*postmarkapp\.com([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call the mail service: post a synthetic message to the route instead");
  // Phase 20h: the generic HTTP SMS gateway is tested with fake fetches against reserved `.example` hosts (and the form's
  // placeholder host); no test may reach a gateway. MM Lite goes to graph.facebook.com, blocked above.
  if (/^https?:\/\/([a-z0-9-]+\.)*([a-z0-9-]+\.example|example-gateway\.com)([/:?#]|$)/i.test(url))
    throw new Error("Tests must never call an SMS gateway: use a fake fetch");
  return realFetch(input, init);
}) as typeof fetch;
