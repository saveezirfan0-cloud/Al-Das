"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { COST_TEMPLATES, type CostKind } from "@/lib/finance/cost-upload";

import { setCostMonth, uploadCosts } from "./actions";

/** Paste a CSV or choose a file. The file is read in the browser and sent as text; nothing is saved until it is valid. */
export function CostUpload({ kind }: { kind: CostKind }) {
  const [text, setText] = React.useState("");
  const [pending, start] = React.useTransition();
  const download = () => {
    const blob = new Blob([COST_TEMPLATES[kind]], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cost-${kind}-template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await uploadCosts(kind, text);
          if (res.ok) {
            toast.success(res.message ?? "Saved");
            setText("");
          } else toast.error(res.error, { duration: 12000 });
        });
      }}
    >
      <Textarea
        id={`csv-${kind}`}
        name="csv"
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={COST_TEMPLATES[kind].trim()}
        className="font-mono text-xs"
        aria-label="CSV text"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`file-${kind}`}
          type="file"
          accept=".csv,text/csv"
          aria-label="Choose a CSV file"
          className="text-xs"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
        <Button type="submit" disabled={pending || text.trim() === ""}>
          {pending && <Loader2 className="animate-spin" />} Save file
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          Download template
        </Button>
      </div>
    </form>
  );
}

export function MonthButton({ month, status }: { month: string; status: "draft" | "approved" }) {
  const [pending, start] = React.useTransition();
  const next = status === "approved" ? "draft" : "approved";
  return (
    <Button
      size="sm"
      variant={status === "approved" ? "outline" : "default"}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setCostMonth(month, next);
          if (res.ok) toast.success(res.message ?? "Done");
          else toast.error(res.error);
        })
      }
    >
      {pending && <Loader2 className="animate-spin" />}{" "}
      {status === "approved" ? "Reopen" : "Approve"}
    </Button>
  );
}
