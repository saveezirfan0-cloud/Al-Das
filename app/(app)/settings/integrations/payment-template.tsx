"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

import { savePaymentTemplate } from "./actions";

type Option = {
  id: string;
  label: string;
  variables: Array<{ key: string; supported: boolean; example: string | null }>;
};

export function PaymentTemplate({
  canManage,
  options,
  templateId,
  variableMap,
  sources,
}: {
  canManage: boolean;
  options: Option[];
  templateId: string | null;
  variableMap: Record<string, string>;
  sources: Array<{ key: string; label: string }>;
}) {
  const [pending, start] = useTransition();
  const [id, setId] = useState<string | null>(templateId);
  const [map, setMap] = useState<Record<string, string>>(variableMap);
  const current = options.find((o) => o.id === id) ?? null;

  function save() {
    start(async () => {
      const r = await savePaymentTemplate({ templateId: id, variableMap: map });
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment message</CardTitle>
        <CardDescription>
          The approved WhatsApp template (Utility category) that carries the payment link. Map one
          variable to the payment link and every other variable to a value. Only text variables in
          the header or body are supported.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid max-w-md gap-1">
          <Label htmlFor="pay-template">Template</Label>
          <select
            id="pay-template"
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            disabled={!canManage}
            value={id ?? ""}
            onChange={(e) => {
              setId(e.target.value || null);
              setMap({});
            }}
          >
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {current?.variables.map((v) => (
          <div key={v.key} className="grid max-w-md gap-1">
            <Label htmlFor={`v-${v.key}`}>
              {v.key}
              {v.example ? (
                <span className="text-muted-foreground font-normal"> (example: {v.example})</span>
              ) : null}
            </Label>
            {v.supported ? (
              <select
                id={`v-${v.key}`}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                disabled={!canManage}
                value={map[v.key] ?? ""}
                onChange={(e) => setMap((m) => ({ ...m, [v.key]: e.target.value }))}
              >
                <option value="">Choose…</option>
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-destructive text-xs">
                A media header or button variable cannot be used for payment messages.
              </p>
            )}
          </div>
        ))}
        {canManage && (
          <div>
            <Button disabled={pending} onClick={save}>
              {pending && <Loader2 className="animate-spin" />} Save template
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
