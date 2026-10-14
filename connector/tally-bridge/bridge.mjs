#!/usr/bin/env node
// Pulse Tally bridge connector. Usage (see README.md):
//   node bridge.mjs pair --url https://<your Pulse address> --code XXXX-XXXX-XXXX-XXXX [--port 9000]
//   node bridge.mjs check      is Tally answering on this PC, is the connector paired
//   node bridge.mjs once       one round (poll Pulse, run the jobs), then exit
//   node bridge.mjs run        the service loop (what NSSM runs)
// Options: --config <file> (default: bridge.config.json next to this file, or PULSE_BRIDGE_CONFIG).

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBridge, VERSION } from "./lib/core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    } else out._.push(a);
  }
  return out;
}

const opts = args(process.argv.slice(2));
const command = opts._[0] ?? "help";
const configPath =
  opts.config ?? process.env.PULSE_BRIDGE_CONFIG ?? join(here, "bridge.config.json");

function readConfig() {
  if (!existsSync(configPath)) return null;
  const c = JSON.parse(readFileSync(configPath, "utf8"));
  return {
    pulseUrl: String(c.pulseUrl ?? ""),
    tallyPort: Number(c.tallyPort ?? 9000),
    token: typeof c.deviceToken === "string" ? c.deviceToken : null,
  };
}

/** The device token is the only secret kept; the file is readable by its owner only (see README for Windows). */
function writeConfig(c) {
  const tmp = `${configPath}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(
      { pulseUrl: c.pulseUrl, tallyPort: c.tallyPort, deviceToken: c.token },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  renameSync(tmp, configPath);
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Windows: protect the file with icacls (README)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (command === "pair") {
    if (!opts.url || !opts.code)
      throw new Error("Usage: node bridge.mjs pair --url https://... --code XXXX-XXXX-XXXX-XXXX");
    const tallyPort = Number(opts.port ?? 9000);
    const bridge = createBridge({ pulseUrl: opts.url, tallyPort });
    const { token } = await bridge.pair(opts.code);
    writeConfig({ pulseUrl: new URL(opts.url).origin, tallyPort, token });
    console.log(
      `Paired. Settings saved to ${configPath}. Now install the service (README, step 5).`,
    );
    return;
  }
  const config = readConfig();
  if (command === "check") {
    if (!config) {
      console.log("Not paired yet (no settings file).");
      return;
    }
    const bridge = createBridge(config);
    console.log(
      `Connector ${VERSION}; Pulse ${config.pulseUrl}; paired: ${config.token ? "yes" : "no"}`,
    );
    console.log(`Tally on 127.0.0.1:${config.tallyPort}: ${await bridge.tallyState()}`);
    return;
  }
  if (command === "once" || command === "run") {
    if (!config?.token) throw new Error("Not paired yet: run `node bridge.mjs pair` first.");
    const bridge = createBridge(config);
    if (command === "once") {
      console.log(JSON.stringify(await bridge.runOnce()));
      return;
    }
    let stopping = false;
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));
    let backoff = 15_000;
    while (!stopping) {
      try {
        const r = await bridge.runOnce();
        backoff = 15_000;
        await sleep(r.pollSeconds * 1000);
      } catch (err) {
        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            event: "round_failed",
            reason: String(err?.message ?? err).slice(0, 200),
          }),
        );
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 300_000);
      }
    }
    return;
  }
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 8)
      .join("\n")
      .replace(/^\/\/ ?/gm, ""),
  );
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
