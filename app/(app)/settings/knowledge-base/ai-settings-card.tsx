"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Switch } from "@/components/ui/switch";
import type { AiSettings } from "@/lib/ai/settings";

import { saveAiSettings } from "./actions";

export function AiSettingsCard({
  canEdit,
  settings,
  groups,
  providerReady,
  embeddingsReady,
  embeddingsFake,
  model,
}: {
  canEdit: boolean;
  settings: AiSettings;
  groups: Array<{ id: string; name: string }>;
  providerReady: boolean;
  embeddingsReady: boolean;
  embeddingsFake: boolean;
  model: string;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [rate, setRate] = useState(String(settings.rate_limit_per_minute));
  const [groupIds, setGroupIds] = useState(settings.kb_group_ids);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const r = await saveAiSettings({ enabled, rate_limit_per_minute: Number(rate), kb_group_ids: groupIds });
      if (r.ok) toast.success(r.message);
      else setError(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI assist</CardTitle>
        <CardDescription>
          Summarize, Ask AI, Suggested Reply, tone, language (English / العربية) and grammar help in the inbox. Model: <code>{model}</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <AlertTitle>What leaves the platform</AlertTitle>
          <AlertDescription>
            When staff use AI assist, the recent messages of that conversation (phone numbers and emails masked, names and everything else
            unchanged) are sent to the AI provider to write the draft. For Suggested Reply, the patient&apos;s latest messages are also sent to the
            embeddings provider to find matching knowledge-base text, and your knowledge-base pages and files are sent to it when they are processed.
            Confirm this fits your data-residency and consent requirements before turning it on. Nothing is sent until a member of staff presses an AI button.
          </AlertDescription>
        </Alert>
        {!providerReady && (
          <Alert variant="destructive">
            <AlertTitle>AI provider not configured</AlertTitle>
            <AlertDescription>Set ANTHROPIC_API_KEY on the server. AI buttons will report that it is not configured until then.</AlertDescription>
          </Alert>
        )}
        {!embeddingsReady && (
          <Alert variant="destructive">
            <AlertTitle>Embeddings not configured</AlertTitle>
            <AlertDescription>Set EMBEDDINGS_API_KEY. Knowledge sources cannot be processed, and Suggested Reply will be ungrounded, until then.</AlertDescription>
          </Alert>
        )}
        {embeddingsFake && (
          <Alert>
            <AlertTitle>Development embeddings</AlertTitle>
            <AlertDescription>EMBEDDINGS_PROVIDER=fake is active: matching works on shared words only. Use a real provider in production.</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="ai-enabled">Turn on AI assist for this workspace</Label>
            <p className="text-muted-foreground text-xs">Members also need the “Use AI assist in the inbox” permission.</p>
          </div>
          <Switch id="ai-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} />
        </div>

        <div className="grid gap-2 md:max-w-xs">
          <Label htmlFor="ai-rate">Requests per person per minute</Label>
          <Input id="ai-rate" type="number" min={1} max={60} value={rate} onChange={(e) => setRate(e.target.value)} disabled={!canEdit} />
        </div>

        <div className="grid gap-2 md:max-w-md">
          <Label>Suggested Reply may use</Label>
          <MultiSelect
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            value={groupIds}
            onChange={setGroupIds}
            placeholder="All knowledge groups"
            emptyText="No groups yet"
            disabled={!canEdit}
          />
          <p className="text-muted-foreground text-xs">Leave empty to use every source.</p>
        </div>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </CardContent>
      {canEdit && (
        <CardFooter>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
