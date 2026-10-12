/**
 * The safety catch on `pnpm demo:reset` (pure). The reset empties a workspace and fills it with made-up data, so it
 * must never run against a real Pulse database. It runs only when ALL of these hold:
 *   1. DEMO_RESET_OK=1 is set in the environment (a deliberate act, never a default);
 *   2. the Supabase URL is on this machine (localhost, 127.x, ::1, host.docker.internal), OR the hosted project is
 *      recognisably a demo project. A hosted URL carries the project reference rather than the project's name, so
 *      "demo in the project name" is accepted in either form: the reference contains "demo", or the person states the
 *      dashboard name in SUPABASE_PROJECT_NAME / DEMO_PROJECT_NAME and it contains "demo".
 *   3. nothing in the host or the stated name says "prod".
 * The database function public.demo_wipe_org adds a second lock: it only empties a workspace that is marked as a
 * training workspace AND was created by this script.
 */
export class DemoGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoGuardError";
  }
}

export type DemoEnv = {
  DEMO_RESET_OK?: string | undefined;
  NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
  SUPABASE_PROJECT_NAME?: string | undefined;
  DEMO_PROJECT_NAME?: string | undefined;
};

export type DemoTarget = {
  host: string;
  why: "local" | "demo project reference" | "demo project name";
};

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
]);

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOCAL_HOSTS.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function assertDemoAllowed(env: DemoEnv): DemoTarget {
  if (env.DEMO_RESET_OK !== "1")
    throw new DemoGuardError(
      "Refusing to run: set DEMO_RESET_OK=1 to confirm you mean to wipe and re-seed a DEMO workspace.",
    );
  const raw = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) throw new DemoGuardError("Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not set.");
  let host: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    host = u.hostname;
  } catch {
    throw new DemoGuardError("Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  }
  if (isLocalHost(host)) return { host, why: "local" };

  const name = (env.SUPABASE_PROJECT_NAME ?? env.DEMO_PROJECT_NAME ?? "").trim().toLowerCase();
  const ref = host.toLowerCase();
  if (/prod/.test(ref) || /prod/.test(name))
    throw new DemoGuardError("Refusing to run: the target looks like a production project.");
  if (ref.split(".")[0].includes("demo")) return { host, why: "demo project reference" };
  if (name.includes("demo")) return { host, why: "demo project name" };
  throw new DemoGuardError(
    `Refusing to run: ${host} is not a local database and is not recognisably a demo project. ` +
      `Use a local Supabase, or a project whose name contains "demo" (set SUPABASE_PROJECT_NAME to the name shown in the dashboard).`,
  );
}
