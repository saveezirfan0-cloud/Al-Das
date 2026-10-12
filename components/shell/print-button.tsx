"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog. Hidden on paper. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button size="sm" onClick={() => window.print()} className="print:hidden">
      <Printer /> {label}
    </Button>
  );
}
