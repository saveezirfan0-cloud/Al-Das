"use client";

import { RunButton } from "@/components/finance/forms";

import { createTallyExport } from "./actions";

export function CreateTallyExportButton({ disabled }: { disabled?: boolean }) {
  if (disabled) return null;
  return (
    <RunButton
      variant="default"
      size="default"
      action={createTallyExport}
      confirm="Build the Tally file now? The vouchers and invoices in it are marked exported and will not be included again."
    >
      Build the Tally file
    </RunButton>
  );
}
