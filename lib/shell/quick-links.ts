/** Pure ranking for the command palette. Framework-free so it can be unit-tested. */

export type QuickLink = {
  href: string;
  label: string;
  /** Section shown on the right of the row (e.g. "Settings · Security & audit"). */
  hint?: string;
  keywords?: readonly string[];
};

function score(link: QuickLink, terms: string[]): number {
  const label = link.label.toLowerCase();
  const hint = (link.hint ?? "").toLowerCase();
  const words = (link.keywords ?? []).map((k) => k.toLowerCase());
  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (label === term) best = 100;
    else if (label.startsWith(term)) best = 80;
    else if (label.split(/\s+/).some((w) => w.startsWith(term))) best = 60;
    else if (label.includes(term)) best = 40;
    else if (words.some((w) => w.startsWith(term))) best = 30;
    else if (words.some((w) => w.includes(term)) || hint.includes(term)) best = 15;
    if (best === 0) return 0; // every term must match something
    total += best;
  }
  return total;
}

/** Links matching every word of the query, best first. An empty query returns the list as given. */
export function rankQuickLinks(query: string, links: readonly QuickLink[]): QuickLink[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...links];
  return links
    .map((link, index) => ({ link, index, s: score(link, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((x) => x.link);
}
