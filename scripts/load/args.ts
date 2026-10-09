/** `--key value`, `--key=value` and bare `--flag` (a flag is a key followed by another --key or nothing). */
export function parseCli(argv: string[]): { flags: Set<string>; opts: Record<string, string> } {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else flags.add(key);
  }
  return { flags, opts };
}
