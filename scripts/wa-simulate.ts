/**
 * Post a sample Meta webhook to the local ingress, signed like Meta does.
 *
 *   pnpm wa:simulate message-text
 *   pnpm wa:simulate status-read --phone-number-id 1234567890 --from 971500000009
 *   pnpm wa:simulate --list
 *   pnpm wa:simulate --all            # every fixture, in order
 *
 * Uses APP_URL and META_APP_SECRET from .env.local. Fixtures live in
 * scripts/wa-fixtures (synthetic data only). --phone-number-id rewrites the
 * metadata so the event lands on a channel you connected locally; --from
 * rewrites the sender's wa_id/from; --waba rewrites entry.id; --template-id /
 * --template-name / --template-language point template status fixtures at a template you
 * created locally.
 */
import "dotenv/config";

import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FIXTURES = path.resolve(process.cwd(), "scripts/wa-fixtures");

type Opts = {
  fixture: string | null;
  list: boolean;
  all: boolean;
  phoneNumberId?: string;
  from?: string;
  waba?: string;
  templateId?: string;
  templateName?: string;
  templateLanguage?: string;
  url?: string;
};

function parseArgs(argv: string[]): Opts {
  const o: Opts = { fixture: null, list: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") o.list = true;
    else if (a === "--all") o.all = true;
    else if (a === "--phone-number-id") o.phoneNumberId = argv[++i];
    else if (a === "--from") o.from = argv[++i];
    else if (a === "--waba") o.waba = argv[++i];
    else if (a === "--template-id") o.templateId = argv[++i];
    else if (a === "--template-name") o.templateName = argv[++i];
    else if (a === "--template-language") o.templateLanguage = argv[++i];
    else if (a === "--url") o.url = argv[++i];
    else if (!a.startsWith("--")) o.fixture = a.replace(/\.json$/, "");
  }
  return o;
}

function listFixtures(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function rewrite(body: Record<string, unknown>, o: Opts): Record<string, unknown> {
  const stamp = Date.now().toString(36);
  const json = JSON.stringify(body)
    // unique message ids per run so idempotency does not swallow repeated simulations
    .replace(/wamid\.FIXTURE_([A-Z0-9]+)"/g, (_m, id: string) => `wamid.FIXTURE_${id}_${stamp}"`);
  const out = JSON.parse(json) as Record<string, unknown>;
  for (const entry of (out.entry as Array<Record<string, unknown>>) ?? []) {
    if (o.waba) entry.id = o.waba;
    for (const change of (entry.changes as Array<Record<string, unknown>>) ?? []) {
      const value = change.value as Record<string, unknown>;
      const metadata = value.metadata as Record<string, unknown> | undefined;
      if (o.phoneNumberId && metadata) metadata.phone_number_id = o.phoneNumberId;
      if (o.templateId && value.message_template_id !== undefined)
        value.message_template_id = Number.isSafeInteger(Number(o.templateId))
          ? Number(o.templateId)
          : o.templateId;
      if (o.templateName && value.message_template_name !== undefined)
        value.message_template_name = o.templateName;
      if (o.templateLanguage && value.message_template_language !== undefined)
        value.message_template_language = o.templateLanguage;
      if (o.from) {
        for (const c of (value.contacts as Array<Record<string, unknown>>) ?? [])
          if (c.wa_id) c.wa_id = o.from;
        for (const m of (value.messages as Array<Record<string, unknown>>) ?? [])
          if (m.from) m.from = o.from;
        for (const s of (value.statuses as Array<Record<string, unknown>>) ?? [])
          if (s.recipient_id) s.recipient_id = o.from;
      }
    }
  }
  return out;
}

async function post(name: string, o: Opts) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
  const body = JSON.stringify(rewrite(raw, o));
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error("META_APP_SECRET missing (the route refuses unsigned posts)");
  const url =
    (o.url ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "") +
    "/api/webhooks/meta";
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
    body,
  });
  console.log(`${name}: ${res.status} ${await res.text()}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const names = listFixtures();
  if (o.list || (!o.fixture && !o.all)) {
    console.log("fixtures:\n  " + names.join("\n  "));
    if (!o.list)
      console.log(
        "\nusage: pnpm wa:simulate <fixture> [--phone-number-id ID] [--from WA_ID] [--waba ID]\n       template-status-*: [--template-id ID] [--template-name NAME] [--template-language CODE]",
      );
    return;
  }
  const targets = o.all ? names : [o.fixture!];
  for (const n of targets) {
    if (!names.includes(n)) throw new Error(`unknown fixture "${n}"`);
    await post(n, o);
  }
  console.log(
    "\nNow drain the queue: pnpm jobs:run meta_events  (then media_fetch / outbound_priority)",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
