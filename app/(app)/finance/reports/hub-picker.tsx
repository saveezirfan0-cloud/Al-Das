"use client";

import * as React from "react";

const SELECT =
  "border-input bg-background h-9 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring";

/**
 * The hub's shared picker: branch, period type, period and "compare with the period before". A plain GET form, so it
 * works without JavaScript (the Apply button); with JavaScript every change applies at once.
 */
export function HubPicker({
  branches,
  branch,
  kind,
  periodKey,
  options,
  compare,
}: {
  branches: ReadonlyArray<{ code: string; name: string }>;
  branch: string | null;
  kind: "month" | "quarter" | "year";
  periodKey: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  compare: boolean;
}) {
  const ref = React.useRef<HTMLFormElement>(null);
  const submit = () => ref.current?.requestSubmit();
  return (
    <form
      ref={ref}
      action="/finance/reports"
      aria-label="Report period and branch"
      className="bg-card flex flex-wrap items-end gap-3 rounded-xl border p-4 print:hidden"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Branch</span>
        <select name="branch" defaultValue={branch ?? "all"} className={SELECT} onChange={submit}>
          <option value="all">All branches</option>
          {branches.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name} ({b.code})
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Period</span>
        <select
          name="period"
          defaultValue={kind}
          className={SELECT}
          onChange={(e) => {
            // a new period type starts on its current period
            const key = e.currentTarget.form?.elements.namedItem("key");
            if (key instanceof HTMLSelectElement) key.disabled = true;
            submit();
          }}
        >
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          {kind === "month" ? "Month" : kind === "quarter" ? "Quarter" : "Year"}
        </span>
        <select name="key" defaultValue={periodKey} className={SELECT} onChange={submit}>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex h-9 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="compare"
          value="1"
          defaultChecked={compare}
          onChange={submit}
          className="size-4"
        />
        Compare with the period before
      </label>
      <noscript>
        <button type="submit" className="h-9 rounded-md border px-3 text-sm">
          Apply
        </button>
      </noscript>
    </form>
  );
}
