"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { PhonePreview } from "@/components/phone-preview/phone-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { buildComponents } from "@/lib/templates/builder";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";

import {
  previewAiAudience,
  saveAiAudienceSegment,
  saveAiTemplateDraft,
  suggestTemplateCopy,
  type AudiencePreview,
  type CopySuggestionView,
} from "../ai-actions";

type Channel = { id: string; name: string; phone: string | null };

export function CopilotWorkspace({
  channels,
  canTemplates,
}: {
  channels: Channel[];
  canTemplates: boolean;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <AudienceCard />
      <CopyCard channels={channels} canTemplates={canTemplates} />
    </div>
  );
}

function AudienceCard() {
  const [request, setRequest] = useState("");
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function build() {
    setError(null);
    setPreview(null);
    setSavedId(null);
    start(async () => {
      const r = await previewAiAudience({ request });
      if (r.ok) setPreview(r.data);
      else setError(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audience</CardTitle>
        <CardDescription>
          Say who should receive the campaign. The AI sees only the names of the available filters
          and the clinic&apos;s tags, places and services, never a patient. Check the explanation
          and the count before you use it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="audience-request">Who should it reach?</Label>
          <Textarea
            id="audience-request"
            rows={3}
            maxLength={600}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="For example: patients who had a completed appointment at the main clinic more than 6 months ago and have no future appointment."
            dir="auto"
          />
          <Button className="w-fit" onClick={build} disabled={pending || !request.trim()}>
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Build audience
          </Button>
        </div>
        {error && (
          <p className="text-destructive flex gap-1.5 text-sm" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
          </p>
        )}
        {preview && (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-sm">{preview.explanation}</p>
            <pre
              className="bg-muted/50 overflow-x-auto rounded-md border p-2 text-xs whitespace-pre-wrap"
              dir="auto"
            >
              {preview.lines.join("\n")}
            </pre>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Patients matching</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {preview.total.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Of those, reachable by a marketing message
                </dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {preview.marketingEligible.toLocaleString()}
                </dd>
              </div>
            </dl>
            <p className="text-muted-foreground text-xs">
              Reachable means opted in to promotions and not stopped. A campaign checks this again
              for every message it sends.
            </p>
            {preview.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
                {w}
              </p>
            ))}
            <div>
              <p className="text-muted-foreground mb-1 text-xs">
                A sample of matching contacts (ids only, {preview.sampleIds.length} of{" "}
                {preview.total.toLocaleString()}):
              </p>
              <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
                {preview.sampleIds.map((id) => (
                  <li key={id} className="bg-muted rounded px-1.5 py-0.5">
                    {id.slice(0, 8)}
                  </li>
                ))}
                {preview.sampleIds.length === 0 && (
                  <li className="text-muted-foreground">No one matches.</li>
                )}
              </ul>
            </div>
            {savedId ? (
              <p className="text-sm">
                Saved as a segment.{" "}
                <Link className="underline" href="/campaigns/new">
                  Start a campaign
                </Link>{" "}
                and pick it as the audience.
              </p>
            ) : (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  start(async () => {
                    const r = await saveAiAudienceSegment({ name, filter: preview.filter });
                    if (r.ok) {
                      setSavedId(r.data.id);
                      toast.success(r.message ?? "Saved.");
                    } else toast.error(r.error);
                  });
                }}
              >
                <div className="grid gap-1">
                  <Label htmlFor="segment-name">Keep as a segment</Label>
                  <Input
                    id="segment-name"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name this audience"
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={pending || !name.trim() || preview.total === 0}
                >
                  Save segment
                </Button>
              </form>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CopyCard({ channels, canTemplates }: { channels: Channel[]; canTemplates: boolean }) {
  const [brief, setBrief] = useState("");
  const [languages, setLanguages] = useState<Array<"en" | "ar">>(["en", "ar"]);
  const [suggestions, setSuggestions] = useState<CopySuggestionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function suggest() {
    setError(null);
    setSuggestions(null);
    start(async () => {
      const r = await suggestTemplateCopy({ brief, languages });
      if (r.ok) setSuggestions(r.data.suggestions);
      else setError(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Template wording</CardTitle>
        <CardDescription>
          Describe the campaign and get English and Arabic wording. Each suggestion is checked
          against the template rules (category, opt-out line, variables, health claims). It is a
          checklist, not a promise: Meta reviews every template you submit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="copy-brief">What is the campaign about?</Label>
          <Textarea
            id="copy-brief"
            rows={3}
            maxLength={800}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="For example: invite patients who have not visited for 6 months to book a yearly check-up this month."
            dir="auto"
          />
          <div className="flex flex-wrap items-center gap-4">
            {(["en", "ar"] as const).map((l) => (
              <label key={l} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={languages.includes(l)}
                  onChange={(e) =>
                    setLanguages(
                      e.target.checked ? [...languages, l] : languages.filter((x) => x !== l),
                    )
                  }
                />
                {l === "en" ? "English" : "العربية"}
              </label>
            ))}
            <Button onClick={suggest} disabled={pending || !brief.trim() || languages.length === 0}>
              {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Suggest wording
            </Button>
          </div>
        </div>
        {error && (
          <p className="text-destructive flex gap-1.5 text-sm" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
          </p>
        )}
        {suggestions?.map((s, i) => (
          <Suggestion key={i} s={s} channels={channels} canTemplates={canTemplates} />
        ))}
      </CardContent>
    </Card>
  );
}

function Suggestion({
  s,
  channels,
  canTemplates,
}: {
  s: CopySuggestionView;
  channels: Channel[];
  canTemplates: boolean;
}) {
  const [channel, setChannel] = useState(channels[0]?.id ?? "");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const preview = renderTemplatePreview(
    buildComponents(s.draft),
    Object.fromEntries(s.draft.bodyExamples.map((e, i) => [`body.${i + 1}`, e])),
  );
  const errors = s.issues.filter((i) => i.severity === "error");
  const warnings = s.issues.filter((i) => i.severity === "warning");

  return (
    <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_16rem]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{s.draft.language === "ar" ? "Arabic" : "English"}</Badge>
          <Badge variant="outline">{s.draft.category.toLowerCase()}</Badge>
          <Badge variant={s.ok ? "success" : "destructive"}>
            {s.ok ? "Passes the checks" : `${errors.length} to fix`}
          </Badge>
        </div>
        <p className="text-muted-foreground font-mono text-xs">{s.draft.name}</p>
        {errors.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-red-700 dark:text-red-400">
            {errors.map((e, k) => (
              <li key={k}>{e.message}</li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-amber-700 dark:text-amber-400">
            {warnings.map((w, k) => (
              <li key={k}>{w.message}</li>
            ))}
          </ul>
        )}
        {savedId ? (
          <p className="text-sm">
            Saved as a draft.{" "}
            <Link className="underline" href={`/templates?edit=${savedId}`}>
              Open it in the template builder
            </Link>{" "}
            to submit it to Meta.
          </p>
        ) : canTemplates && channels.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="bg-background rounded-md border px-2 py-1 text-sm"
              value={channel}
              aria-label="WhatsApp number"
              onChange={(e) => setChannel(e.target.value)}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !s.ok}
              title={s.ok ? undefined : "Fix the checks first"}
              onClick={() =>
                start(async () => {
                  const r = await saveAiTemplateDraft({ channel_id: channel, draft: s.draft });
                  if (r.ok) setSavedId(r.data.id);
                  else toast.error(r.error);
                })
              }
            >
              Save as draft template
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Saving a template needs the template permission and an active WhatsApp number.
          </p>
        )}
      </div>
      <div dir={s.draft.language === "ar" ? "rtl" : "ltr"}>
        <PhonePreview preview={preview} />
      </div>
    </div>
  );
}
