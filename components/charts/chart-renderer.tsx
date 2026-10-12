"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import type { ChartSpec } from "@/lib/reports/types";

import { ChartCard } from "./chart-card";
import { Heatmap } from "./heatmap";
import { HBarList } from "./hbar-list";

// Recharts is the heaviest dependency on the dashboards: load it only when a bar or line chart is drawn.
const chartPlaceholder = () => <Skeleton className="h-60 w-full" aria-label="Loading chart" />;
const BarsChart = dynamic(() => import("./bars-chart").then((m) => m.BarsChart), { ssr: false, loading: chartPlaceholder });
const LineChart = dynamic(() => import("./line-chart").then((m) => m.LineChart), { ssr: false, loading: chartPlaceholder });

/** Maps a serializable ChartSpec (built on the server) to its component. */
export function ChartRenderer({ spec }: { spec: ChartSpec }) {
  return (
    <ChartCard title={spec.title} description={spec.description}>
      {spec.kind === "bars" && <BarsChart data={spec.data} xKey={spec.xKey} series={spec.series} stacked={spec.stacked} format={spec.format} label={spec.title} />}
      {spec.kind === "line" && <LineChart data={spec.data} xKey={spec.xKey} series={spec.series} format={spec.format} label={spec.title} />}
      {spec.kind === "hbars" && <HBarList items={spec.items} format={spec.format} />}
      {spec.kind === "heatmap" && <Heatmap cells={spec.cells} />}
    </ChartCard>
  );
}
