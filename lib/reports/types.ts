import type { ValueFormat } from "@/lib/reports/format";
import type { AdminClient } from "@/lib/supabase/admin";
import type { ReportFilters } from "@/lib/reports/filters";
import type { ResolvedRange } from "@/lib/reports/range";

export type Kpi = { key: string; label: string; value: number | null; format: ValueFormat; hint?: string };

type Row = Record<string, string | number | null>;

/** Serializable chart specs: the server builds them, client components in components/charts render them. */
export type ChartSpec =
  | {
      kind: "bars";
      title: string;
      description?: string;
      xKey: string;
      series: Array<{ key: string; label: string }>;
      data: Row[];
      stacked?: boolean;
      format?: ValueFormat;
    }
  | {
      kind: "line";
      title: string;
      description?: string;
      xKey: string;
      series: Array<{ key: string; label: string }>;
      data: Row[];
      format?: ValueFormat;
    }
  | { kind: "hbars"; title: string; description?: string; items: Array<{ label: string; value: number }>; format?: ValueFormat }
  | { kind: "heatmap"; title: string; description?: string; cells: Array<{ dow: number; hour: number; value: number }> };

export type TableColumn = { key: string; label: string; format?: ValueFormat };

export type ReportResult = {
  kpis: Kpi[];
  charts: ChartSpec[];
  table: { columns: TableColumn[]; rows: Row[] };
  /** Caveats shown under the filters, e.g. which filters a number ignores. */
  notes: string[];
};

export type ReportContext = {
  admin: AdminClient;
  orgId: string;
  timezone: string;
  filters: ReportFilters;
  range: ResolvedRange;
};

export type FilterKind = "channel" | "team" | "user";
export const REPORT_GROUPS = ["Conversations", "People", "WhatsApp", "Enquiries", "Campaigns", "Appointments"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export type ReportDef = {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  /** Which shared filters this report honours. */
  filters: FilterKind[];
  /** Views/materialized views this report reads. They must exist (report_sources_available). */
  requires: string[];
  /** Set while the report has no implementation yet: the phase that delivers its data. */
  awaiting?: string;
  run?: (ctx: ReportContext) => Promise<ReportResult>;
};
