import { seriesColor } from "./theme";

/** Present for two or more series. Identity is the swatch beside the text; the text itself stays in the text token. */
export function Legend({ series }: { series: Array<{ key: string; label: string }> }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: seriesColor(i) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
