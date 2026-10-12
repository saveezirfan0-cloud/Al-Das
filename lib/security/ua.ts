/**
 * Pure helpers that turn a raw User-Agent into something safe to store: a coarse "browser on OS"
 * family. The full string (version numbers, build ids) can fingerprint a person, so it is never kept.
 */

const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\b(?:Chrome|CriOS)\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\bAndroid\b/, "Android"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bWindows\b/, "Windows"],
  [/\b(?:Macintosh|Mac OS X)\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/** "Chrome on Windows", "Safari on iOS", or "Unknown device". Never longer than 40 characters. */
export function uaFamily(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua) return "Unknown device";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (!browser && !system) return "Unknown device";
  return `${browser ?? "Browser"} on ${system ?? "unknown system"}`;
}
