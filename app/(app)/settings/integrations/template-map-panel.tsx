"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type Option = {
  id: string;
  label: string;
  variables: Array<{ key: string; supported: boolean; example: string | null }>;
};

type SaveResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Chooses the approved WhatsApp template an integration sends and maps each of its variables to one of a closed set of values.
 * Used by payment links and by review requests; the server action (`save`) checks the choice again.
 */
export function TemplateMapPanel({
  title,
  description,
  idPrefix,
  save: saveTemplate,
  canManage,
  options,
  templateId,
  variableMap,
  sources,
}: {
  title: string;
  description: string;
  idPrefix: string;
  save: (input: {
    templateId: string | null;
    variableMap: Record<string, string>;
  }) => Promise<SaveResult>;
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
      const r = await saveTemplate({ templateId: id, variableMap: map });
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid max-w-md gap-1">
          <Label htmlFor={`${idPrefix}-template`}>Template</Label>
          <select
            id={`${idPrefix}-template`}
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
                A media header or button variable cannot be used here.
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
