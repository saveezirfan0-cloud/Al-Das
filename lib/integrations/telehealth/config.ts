import type { Config } from "@/lib/integrations/accounts";

export type TelehealthConfig = {
  provider: "static" | "daily";
  urlTemplate: string;
  dailyDomain: string;
  /** Minutes after the booked end that the room still works. */
  graceMinutes: number;
  /** Minutes before the start that the room opens (providers that can enforce it). */
  earlyMinutes: number;
};

const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function readTelehealthConfig(config: Config): TelehealthConfig {
  return {
    provider: config.provider === "daily" ? "daily" : "static",
    urlTemplate: typeof config.url_template === "string" ? config.url_template.trim() : "",
    dailyDomain: typeof config.domain === "string" ? config.domain.trim().toLowerCase() : "",
    graceMinutes: int(config.grace_minutes, 30, 0, 240),
    earlyMinutes: int(config.early_minutes, 60, 0, 240),
  };
}
