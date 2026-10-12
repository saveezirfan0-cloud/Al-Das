"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

import type { BuilderFlow, BuilderLookups } from "./flow-builder";

/** React Flow is large and only the builder page needs it: load it on demand, in the browser only. */
const FlowBuilder = dynamic(() => import("./flow-builder").then((m) => m.FlowBuilder), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the flow builder"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-[60vh]" />
    </div>
  ),
});

export function FlowBuilderLoader(props: {
  flow: BuilderFlow;
  lookups: BuilderLookups;
  canAi: boolean;
}) {
  return <FlowBuilder {...props} />;
}
