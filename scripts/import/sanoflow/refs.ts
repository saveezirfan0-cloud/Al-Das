/**
 * Location, specialist and service names from a Sanoflow export → Pulse rows, through
 * sanoflow-names.json first and then an exact (case-insensitive) name match. Cached per run.
 */
import { mapName } from "./config";
import type { RefRow, RefTable } from "./ports";
import type { RunContext } from "./run";

const NAME_KEY: Record<RefTable, "locations" | "specialists" | "services"> = {
  locations: "locations",
  specialists: "specialists",
  services: "services",
};

export class RefResolver {
  private cache = new Map<string, RefRow | null>();
  constructor(private readonly ctx: RunContext) {}

  async get(table: RefTable, raw: string): Promise<RefRow | null> {
    const name = raw.trim();
    if (!name) return null;
    const mapped = mapName(this.ctx.names[NAME_KEY[table]], name);
    const key = `${table}|${mapped.toLowerCase()}`;
    if (!this.cache.has(key)) this.cache.set(key, await this.ctx.ports.findByName(table, mapped));
    return this.cache.get(key) ?? null;
  }
}
