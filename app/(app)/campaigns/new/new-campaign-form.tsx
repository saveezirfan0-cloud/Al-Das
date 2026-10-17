"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { MediaPicker } from "@/components/media/media-picker";
import { PhonePreview } from "@/components/phone-preview/phone-preview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AB_SPLIT_DEFAULT, AB_SPLIT_MAX, AB_SPLIT_MIN } from "@/lib/campaigns/ab";
import { DEFAULT_GUARDRAILS, MAX_RECIPIENTS, skipReasonLabel } from "@/lib/campaigns/constants";
import {
  checkRecurrenceSchedule,
  describeCron,
  RECURRENCE_PRESETS,
  upcomingRuns,
} from "@/lib/campaigns/recurrence";
import {
  CONTACT_SOURCES,
  parseSource,
  resolveVariables,
  unmappedVariables,
} from "@/lib/campaigns/variables";
import { TEMPLATE_HEADER_TYPES } from "@/lib/media/limits";
import { mediaSource } from "@/lib/media/paths";
import { renderTemplatePreview, templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import {
  createCampaign,
  createRecurringCampaign,
  previewAudience,
  sendTestMessage,
  type AudiencePreviewResult,
} from "../actions";

export type FormChannel = {
  id: string;
  name: string;
  wabaId: string;
  phone: string | null;
  quality: string | null;
  tier: string | null;
};
export type FormTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  wabaId: string;
  components: MetaTemplateComponent[];
  variableMap: Record<string, string>;
};
export type FormSegment = {
  id: string;
  name: string;
  kind: string;
  count: number;
  /** Care programmes only: cannot be used for a campaign. */
  careOnly?: boolean;
};

const TEXT = "__text__";
const NONE = "__none__";
const RETRY_DELAYS = [
  { v: 30, label: "30 minutes" },
  { v: 60, label: "1 hour" },
  { v: 240, label: "4 hours" },
  { v: 720, label: "12 hours" },
  { v: 1440, label: "24 hours" },
];

function sourceKind(value: string | undefined): string {
  if (!value) return NONE;
  if (value.startsWith("text:")) return TEXT;
  return value;
}

export function NewCampaignForm({
  channels,
  templates,
  segments,
  customFields,
  timezone,
  canMedia = false,
  initialMode = "now",
}: {
  channels: FormChannel[];
  templates: FormTemplate[];
  segments: FormSegment[];
  customFields: Array<{ key: string; label: string }>;
  timezone: string;
  /** May this person pick from the Media Library (media.view)? */
  canMedia?: boolean;
  /** "repeat" when opened from Recurring campaigns. */
  initialMode?: "now" | "later" | "repeat";
}) {
  const [ask, askDialog] = useConfirm();
  const router = useRouter();
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [templateId, setTemplateId] = useState("");
  const [audienceType, setAudienceType] = useState<"segment" | "csv">("segment");
  const [segmentId, setSegmentId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvName, setCsvName] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [map, setMap] = useState<Record<string, string>>({});
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"now" | "later" | "repeat">(initialMode);
  const [atLocal, setAtLocal] = useState("");
  const [cron, setCron] = useState(RECURRENCE_PRESETS[2]!.cron);
  const cronSummary = useMemo(() => describeCron(cron), [cron]);
  const cronProblem = useMemo(
    () => (mode === "repeat" ? checkRecurrenceSchedule(cron, timezone, new Date()) : null),
    [mode, cron, timezone],
  );
  const nextRuns = useMemo(
    () => (mode === "repeat" && !cronProblem ? upcomingRuns(cron, new Date(), timezone, 3) : []),
    [mode, cron, cronProblem, timezone],
  );
  const [retryRounds, setRetryRounds] = useState(0);
  const [retryDelay, setRetryDelay] = useState(60);
  const [maxFailure, setMaxFailure] = useState(DEFAULT_GUARDRAILS.max_failure_pct);
  const [pauseOnQuality, setPauseOnQuality] = useState(true);
  const [testPhone, setTestPhone] = useState("");
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // Phase 20g A/B test (one-off campaigns only): version B and the share of the audience that gets it.
  const [abOn, setAbOn] = useState(false);
  const [abTemplateId, setAbTemplateId] = useState("");
  const [abMap, setAbMap] = useState<Record<string, string>>({});
  const [abFallbacks, setAbFallbacks] = useState<Record<string, string>>({});
  const [abSplit, setAbSplit] = useState(AB_SPLIT_DEFAULT);
  const [previewSide, setPreviewSide] = useState<"a" | "b">("a");

  const [preview, setPreview] = useState<AudiencePreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const [creating, startCreate] = useTransition();
  const [testing, startTest] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const channel = channels.find((c) => c.id === channelId) ?? null;
  const channelTemplates = useMemo(
    () => templates.filter((t) => !channel || t.wabaId === channel.wabaId),
    [templates, channel],
  );
  const template = channelTemplates.find((t) => t.id === templateId) ?? null;
  const vars = useMemo(() => (template ? templateVariables(template.components) : []), [template]);
  const marketing = template?.category.toUpperCase() === "MARKETING";
  // Version B: same number, same category as A (consent is decided by A's category).
  const abTemplates = useMemo(
    () =>
      template
        ? channelTemplates.filter(
            (t) => t.category.toUpperCase() === template.category.toUpperCase(),
          )
        : [],
    [channelTemplates, template],
  );
  const abActive = abOn && mode !== "repeat";
  const abTemplate = abActive ? (abTemplates.find((t) => t.id === abTemplateId) ?? null) : null;
  const abVars = useMemo(
    () => (abTemplate ? templateVariables(abTemplate.components) : []),
    [abTemplate],
  );

  // Keep the selected template valid for the chosen number.
  useEffect(() => {
    if (templateId && !channelTemplates.some((t) => t.id === templateId)) setTemplateId("");
  }, [channelTemplates, templateId]);

  useEffect(() => {
    if (abTemplateId && !abTemplates.some((t) => t.id === abTemplateId)) setAbTemplateId("");
  }, [abTemplates, abTemplateId]);

  // Version B starts from its template's own variable_map.
  useEffect(() => {
    if (!abTemplate) return;
    const next: Record<string, string> = {};
    for (const v of templateVariables(abTemplate.components)) {
      const m = abTemplate.variableMap[v.key];
      if (m && parseSource(m)) next[v.key] = m;
    }
    setAbMap(next);
    setAbFallbacks({});
  }, [abTemplate]);

  // Starting point for the mapping: the template's own variable_map.
  useEffect(() => {
    if (!template) return;
    const next: Record<string, string> = {};
    for (const v of templateVariables(template.components)) {
      const m = template.variableMap[v.key];
      if (m && parseSource(m)) next[v.key] = m;
    }
    setMap(next);
    setFallbacks({});
  }, [template]);

  // Re-check the audience whenever what defines it changes.
  const audienceReady =
    !!template && !!channel && (audienceType === "segment" ? !!segmentId : csvText.length > 0);
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!audienceReady || !template || !channel) return;
    const handle = setTimeout(() => {
      startCheck(async () => {
        const r = await previewAudience({
          channel_id: channel.id,
          template_id: template.id,
          audience:
            audienceType === "segment"
              ? { type: "segment", segment_id: segmentId }
              : { type: "csv", csv_text: csvText, opt_in_confirmed: optIn },
        });
        if (r.ok) setPreview(r.data);
        else setPreviewError(r.error);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [audienceReady, audienceType, segmentId, csvText, optIn, template, channel]);

  const csvColumns = preview?.csv?.columns ?? [];
  const sourceOptions = [
    ...CONTACT_SOURCES.map((s) => ({ value: s.key, label: s.label, group: "Contact" })),
    ...customFields.map((f) => ({
      value: `custom.${f.key}`,
      label: f.label,
      group: "Custom field",
    })),
    ...(audienceType === "csv"
      ? csvColumns.map((c) => ({ value: `csv.${c}`, label: c, group: "CSV column" }))
      : []),
  ];

  const sample = preview?.sample ?? null;
  // The preview and the test send show version A, or version B when it is chosen above the preview.
  const showB = previewSide === "b" && !!abTemplate;
  const shownTemplate = showB ? abTemplate : template;
  const shownMap = showB ? abMap : map;
  const shownFallbacks = showB ? abFallbacks : fallbacks;
  const resolved = useMemo(() => {
    if (!shownTemplate) return null;
    return resolveVariables({
      components: shownTemplate.components,
      map: shownMap,
      templateMap: shownTemplate.variableMap,
      fallbacks: shownFallbacks,
      contact: sample ?? {},
      csv: sample?.csv ?? {},
    });
  }, [shownTemplate, shownMap, shownFallbacks, sample]);

  const phonePreview = useMemo(() => {
    if (!shownTemplate || !resolved) return null;
    // Unresolved variables show the template's example so the bubble reads naturally.
    const values = { ...resolved.values };
    for (const v of templateVariables(shownTemplate.components))
      if (!values[v.key]) values[v.key] = v.example ?? `{{${v.name}}}`;
    return renderTemplatePreview(shownTemplate.components, values);
  }, [shownTemplate, resolved]);

  const unmapped = template
    ? unmappedVariables(template.components, map, template.variableMap).filter(
        (v) => !fallbacks[v.key],
      )
    : [];
  const mediaMissing = (
    list: ReturnType<typeof templateVariables>,
    m: Record<string, string>,
    templateMap: Record<string, string> | undefined,
    fb: Record<string, string>,
  ) =>
    list.some((v) => {
      if (v.kind !== "image" && v.kind !== "video" && v.kind !== "document") return false;
      const src = parseSource(m[v.key] ?? templateMap?.[v.key]);
      if (src?.kind === "media") return false;
      const url = src?.kind === "text" ? src.value : fb[v.key];
      return !url || !/^https:\/\//i.test(url);
    });
  const badMedia = mediaMissing(vars, map, template?.variableMap, fallbacks);
  const abUnmapped = abTemplate
    ? unmappedVariables(abTemplate.components, abMap, abTemplate.variableMap).filter(
        (v) => !abFallbacks[v.key],
      )
    : [];

  const eligible = preview?.counts.eligible ?? 0;
  const tierLimit = preview?.tierLimit ?? null;
  const overTier = tierLimit !== null && eligible > Math.floor(tierLimit * 0.9);

  const problems: string[] = [];
  if (!name.trim()) problems.push("Name the campaign.");
  if (!channel) problems.push("Choose a number.");
  if (!template) problems.push("Choose a template.");
  if (!preview) problems.push("Choose an audience.");
  else if (preview.counts.tooMany)
    problems.push(`The audience is larger than ${MAX_RECIPIENTS.toLocaleString()}.`);
  else if (eligible === 0) problems.push("Nobody in the audience can receive this message.");
  if (unmapped.length) problems.push(`Map ${unmapped.map((v) => v.key).join(", ")}.`);
  if (badMedia)
    problems.push("The header media needs a Media Library file or a public https:// link.");
  if (mode === "later" && !atLocal) problems.push("Pick a send time.");
  if (mode === "repeat" && audienceType !== "segment")
    problems.push("A recurring campaign needs a segment (it is re-read on every run).");
  if (mode === "repeat" && cronProblem) problems.push(cronProblem);
  if (abActive) {
    if (!abTemplate) problems.push("Choose the template for version B.");
    else {
      if (abUnmapped.length)
        problems.push(`Version B: map ${abUnmapped.map((v) => v.key).join(", ")}.`);
      if (mediaMissing(abVars, abMap, abTemplate.variableMap, abFallbacks))
        problems.push("Version B: the header media needs a Media Library file or a https:// link.");
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 12_000_000) {
      toast.error("That file is too large (max 12 MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(String(reader.result ?? ""));
      setCsvName(file.name);
    };
    reader.readAsText(file);
  }

  function setSourceIn(
    setter: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    key: string,
    value: string,
  ) {
    setter((prev) => {
      const next = { ...prev };
      if (value === NONE) delete next[key];
      else if (value === TEXT) next[key] = "text:";
      else next[key] = value;
      return next;
    });
  }

  async function start() {
    if (!template || !channel || problems.length) return;
    if (mode === "repeat") {
      if (
        !(await ask({
          title: `Send "${template.name}" to the segment ${(cronSummary ?? cron).toLowerCase()} (${timezone})?`,
          description: `Each run re-reads the segment; about ${eligible.toLocaleString()} people today.`,
          confirmLabel: "Save recurring campaign",
        }))
      )
        return;
      startCreate(async () => {
        const r = await createRecurringCampaign({
          name,
          channel_id: channel.id,
          template_id: template.id,
          segment_id: segmentId,
          variable_map: map,
          fallbacks,
          cron,
          retry_rounds: retryRounds,
          retry_delay_minutes: retryDelay,
          guardrails: { max_failure_pct: maxFailure, pause_on_quality_drop: pauseOnQuality },
        });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success(r.message ?? "Recurring campaign saved.");
        router.push("/campaigns/recurring");
      });
      return;
    }
    const when = mode === "later" ? `at ${atLocal.replace("T", " ")} (${timezone})` : "now";
    const what = abTemplate
      ? `"${template.name}" (A) and "${abTemplate.name}" (B, about ${abSplit}%)`
      : `"${template.name}"`;
    if (
      !(await ask({
        title: `Send ${what} to ${eligible.toLocaleString()} people ${when}?`,
        confirmLabel: mode === "later" ? "Schedule" : "Send",
      }))
    )
      return;
    startCreate(async () => {
      const r = await createCampaign({
        name,
        channel_id: channel.id,
        template_id: template.id,
        audience:
          audienceType === "segment"
            ? { type: "segment", segment_id: segmentId }
            : { type: "csv", csv_text: csvText, opt_in_confirmed: optIn },
        variable_map: map,
        fallbacks,
        schedule: {
          mode: mode === "later" ? "later" : "now",
          at_local: mode === "later" ? atLocal : undefined,
        },
        retry_rounds: retryRounds,
        retry_delay_minutes: retryDelay,
        guardrails: { max_failure_pct: maxFailure, pause_on_quality_drop: pauseOnQuality },
        variant_b: abTemplate
          ? {
              template_id: abTemplate.id,
              variable_map: abMap,
              fallbacks: abFallbacks,
              split_pct: abSplit,
            }
          : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Campaign created.");
      router.push(`/campaigns?c=${r.data.id}`);
    });
  }

  function test() {
    if (!shownTemplate || !channel) return;
    startTest(async () => {
      const r = await sendTestMessage({
        channel_id: channel.id,
        template_id: shownTemplate.id,
        phone: testPhone,
        variable_map: shownMap,
        fallbacks: shownFallbacks,
        csv_sample: sample?.csv ?? {},
      });
      if (r.ok) toast.success(r.message ?? "Test queued.");
      else toast.error(r.error);
    });
  }

  type MappingSide = {
    id: "a" | "b";
    title: string;
    vars: ReturnType<typeof templateVariables>;
    map: Record<string, string>;
    setMap: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    fallbacks: Record<string, string>;
    setFallbacks: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  };

  /** Phase 20g A/B test: version B (template, share, its own variable mapping). Not offered for repeats. */
  function renderAbCard() {
    return (
      <Card>
        <CardHeader>
          <CardTitle>A/B test</CardTitle>
          <CardDescription>
            Send a second version to part of the audience and compare sent, delivered, read, replied
            and clicked. Each person always gets the same version, also in retry rounds.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={abOn} onCheckedChange={setAbOn} />
            Test a second version (B)
          </label>
          {abOn && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Version B template</Label>
                <Select value={abTemplateId} onValueChange={setAbTemplateId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {abTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} · {t.language}
                        {t.id === template?.id ? " (same as A)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Same category as version A. Pick the same template to test other variable values.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ab-split">Share that gets version B (%)</Label>
                <Input
                  id="ab-split"
                  type="number"
                  min={AB_SPLIT_MIN}
                  max={AB_SPLIT_MAX}
                  value={abSplit}
                  onChange={(e) =>
                    setAbSplit(
                      Math.min(
                        AB_SPLIT_MAX,
                        Math.max(AB_SPLIT_MIN, Math.round(Number(e.target.value) || 0)),
                      ),
                    )
                  }
                  className="w-24"
                />
                <p className="text-muted-foreground text-xs">
                  About {abSplit}% get B and {100 - abSplit}% get A. Who gets which is fixed per
                  person.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  /** The variable mapping card, for version A and (A/B test) version B. */
  function renderMapping(side: MappingSide) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{side.title}</CardTitle>
          <CardDescription>
            Each variable is filled per recipient. A fallback is used when the value is blank.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {side.vars.map((v) => {
            const isMedia = v.kind === "image" || v.kind === "video" || v.kind === "document";
            const current = side.map[v.key] ?? undefined;
            const kind = isMedia ? TEXT : sourceKind(current);
            return (
              <div
                key={v.key}
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[8rem_1fr_9rem]"
              >
                <div>
                  <code className="text-xs">{v.key}</code>
                  {v.example && (
                    <span className="text-muted-foreground block truncate text-xs">
                      e.g. {v.example}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {isMedia ? (
                    <>
                      {current?.startsWith("media:") ? (
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span>A Media Library file will be sent with every message.</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              side.setMap((p) => {
                                const next = { ...p };
                                delete next[v.key];
                                return next;
                              })
                            }
                          >
                            Use a link instead
                          </Button>
                        </div>
                      ) : (
                        <Input
                          value={current?.startsWith("text:") ? current.slice(5) : ""}
                          onChange={(e) =>
                            side.setMap((p) => ({ ...p, [v.key]: `text:${e.target.value}` }))
                          }
                          placeholder={`https://… public ${v.kind} link`}
                        />
                      )}
                      {canMedia && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          onClick={() => setPickerFor(side.id + v.key)}
                        >
                          Choose from the Media Library
                        </Button>
                      )}
                      {pickerFor === side.id + v.key && (
                        <MediaPicker
                          open
                          onOpenChange={(o) => !o && setPickerFor(null)}
                          kind={v.kind as "image" | "video" | "document"}
                          mimes={TEMPLATE_HEADER_TYPES[v.kind as "image" | "video" | "document"]}
                          title="Choose the header file"
                          onPick={(a) => side.setMap((p) => ({ ...p, [v.key]: mediaSource(a.id) }))}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <Select
                        value={kind}
                        onValueChange={(val) => setSourceIn(side.setMap, v.key, val)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a source" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Not mapped</SelectItem>
                          {sourceOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.group}: {o.label}
                            </SelectItem>
                          ))}
                          <SelectItem value={TEXT}>Fixed text…</SelectItem>
                        </SelectContent>
                      </Select>
                      {kind === TEXT && (
                        <Input
                          value={current?.startsWith("text:") ? current.slice(5) : ""}
                          onChange={(e) =>
                            side.setMap((p) => ({ ...p, [v.key]: `text:${e.target.value}` }))
                          }
                          placeholder="Same text for everyone"
                        />
                      )}
                    </>
                  )}
                </div>
                <Input
                  value={side.fallbacks[v.key] ?? ""}
                  onChange={(e) => side.setFallbacks((p) => ({ ...p, [v.key]: e.target.value }))}
                  placeholder="Fallback"
                  aria-label={`Fallback for ${v.key}${side.id === "b" ? " (version B)" : ""}`}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>
    );
  }

  if (channels.length === 0)
    return (
      <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
        No active WhatsApp number. Add one in Settings → Channels first.
      </p>
    );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="c-name">Campaign name</Label>
              <Input
                id="c-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Flu vaccine reminder – October"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>WhatsApp number</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a number" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.phone ? ` · ${c.phone}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {channel && (
                <p className="text-muted-foreground text-xs">
                  Quality {channel.quality ?? "unknown"} · limit{" "}
                  {channel.tier?.replace("TIER_", "") ?? "unknown"} contacts / 24 h
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Message template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      channelTemplates.length ? "Choose a template" : "No approved templates"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {channelTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · {t.language} · {t.category.toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Only approved templates for this number&apos;s account are listed.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audience</CardTitle>
            <CardDescription>
              {marketing
                ? "Marketing template: only contacts with a marketing opt-in who have not opted out are included."
                : "Contacts who have a WhatsApp phone or user id are included."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex gap-2">
              {(["segment", "csv"] as const).map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={audienceType === t ? "default" : "outline"}
                  onClick={() => setAudienceType(t)}
                >
                  {t === "segment" ? "Segment" : "Upload CSV"}
                </Button>
              ))}
            </div>

            {audienceType === "segment" ? (
              <div className="grid gap-1.5">
                <Select value={segmentId} onValueChange={setSegmentId}>
                  <SelectTrigger className="max-w-sm">
                    <SelectValue
                      placeholder={segments.length ? "Choose a segment" : "No segments yet"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {segments.map((s) => (
                      <SelectItem key={s.id} value={s.id} disabled={s.careOnly}>
                        {s.name} · {s.kind} · ~{s.count.toLocaleString()}
                        {s.careOnly ? " · care programmes only" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Build segments in Patients. The audience is frozen when you start the campaign.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => onFile(e.target.files?.[0])}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload /> {csvName ? "Replace file" : "Choose CSV file"}
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    {csvName || "Needs a phone column; other columns can fill template variables."}
                  </span>
                </div>
                {marketing && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={optIn}
                      onCheckedChange={(c) => setOptIn(c === true)}
                      className="mt-0.5"
                    />
                    <span>
                      I confirm everyone in this file agreed to receive marketing messages from us.
                      Numbers not yet in Contacts are added as opted-in contacts; existing contacts
                      keep their own consent record.
                    </span>
                  </label>
                )}
              </div>
            )}

            {checking && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> Checking audience…
              </p>
            )}
            {previewError && <p className="text-destructive text-sm">{previewError}</p>}
            {preview && !checking && (
              <div className="rounded-md border p-3 text-sm">
                <p>
                  <strong className="tabular-nums">
                    {preview.counts.eligible.toLocaleString()}
                  </strong>{" "}
                  of <span className="tabular-nums">{preview.counts.total.toLocaleString()}</span>{" "}
                  will receive this
                  {preview.counts.created > 0 &&
                    ` (${preview.counts.created.toLocaleString()} new contacts will be added)`}
                  .
                </p>
                {Object.keys(preview.counts.skipped).length > 0 && (
                  <ul className="text-muted-foreground mt-1 text-xs">
                    {Object.entries(preview.counts.skipped).map(([reason, n]) => (
                      <li key={reason}>
                        {n.toLocaleString()} skipped: {skipReasonLabel(reason)}
                      </li>
                    ))}
                  </ul>
                )}
                {preview.csv && (preview.csv.rejectedCount > 0 || preview.csv.duplicates > 0) && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {preview.csv.rejectedCount > 0 &&
                      `${preview.csv.rejectedCount} rows ignored (${preview.csv.rejected
                        .slice(0, 3)
                        .map((r) => `line ${r.line}: ${r.reason.toLowerCase()}`)
                        .join("; ")}${preview.csv.rejectedCount > 3 ? "…" : ""}). `}
                    {preview.csv.duplicates > 0 &&
                      `${preview.csv.duplicates} duplicate numbers merged.`}
                  </p>
                )}
                {preview.counts.tooMany && (
                  <p className="text-destructive mt-1 text-xs">
                    Too many contacts: the limit is {MAX_RECIPIENTS.toLocaleString()} per campaign.
                  </p>
                )}
                {overTier && (
                  <p className="mt-2 flex gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    This is close to or above the number&apos;s limit of{" "}
                    {tierLimit?.toLocaleString()} contacts per 24 hours. Sending pauses
                    automatically at 90% of the limit and continues when it frees up.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {template &&
          vars.length > 0 &&
          renderMapping({
            id: "a",
            title: abTemplate ? "Template variables (version A)" : "Template variables",
            vars,
            map,
            setMap,
            fallbacks,
            setFallbacks,
          })}

        {template && mode !== "repeat" && renderAbCard()}

        {abTemplate &&
          abVars.length > 0 &&
          renderMapping({
            id: "b",
            title: "Template variables (version B)",
            vars: abVars,
            map: abMap,
            setMap: setAbMap,
            fallbacks: abFallbacks,
            setFallbacks: setAbFallbacks,
          })}

        <Card>
          <CardHeader>
            <CardTitle>When and how</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {(["now", "later", "repeat"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? "default" : "outline"}
                  onClick={() => {
                    setMode(m);
                    if (m === "repeat") setAudienceType("segment");
                  }}
                >
                  {m === "now" ? "Send immediately" : m === "later" ? "Schedule" : "Repeat"}
                </Button>
              ))}
              {mode === "later" && (
                <span className="flex items-center gap-2">
                  <Input
                    type="datetime-local"
                    value={atLocal}
                    onChange={(e) => setAtLocal(e.target.value)}
                    className="w-56"
                  />
                  <span className="text-muted-foreground text-xs">{timezone}</span>
                </span>
              )}
            </div>

            {mode === "repeat" && (
              <div className="grid gap-2 rounded-lg border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>Repeat</Label>
                    <Select
                      value={RECURRENCE_PRESETS.find((p) => p.cron === cron)?.key ?? "custom"}
                      onValueChange={(k) => {
                        const p = RECURRENCE_PRESETS.find((x) => x.key === k);
                        if (p) setCron(p.cron);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RECURRENCE_PRESETS.map((p) => (
                          <SelectItem key={p.key} value={p.key}>
                            {p.label}
                          </SelectItem>
                        ))}
                        <SelectItem value="custom">Custom schedule</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="repeat-cron">
                      Schedule (cron: minute hour day month weekday)
                    </Label>
                    <Input
                      id="repeat-cron"
                      value={cron}
                      onChange={(e) => setCron(e.target.value)}
                      className="font-mono"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <p className="text-sm">
                  {cronSummary ?? "Not a valid schedule"}{" "}
                  <span className="text-muted-foreground text-xs">({timezone})</span>
                </p>
                {cronProblem ? (
                  <p className="text-destructive text-xs">{cronProblem}</p>
                ) : (
                  nextRuns.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      Next runs:{" "}
                      {nextRuns
                        .map((d) =>
                          d.toLocaleString("en-GB", {
                            timeZone: timezone,
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          }),
                        )
                        .join(" · ")}
                    </p>
                  )
                )}
                <p className="text-muted-foreground text-xs">
                  Every run reads the segment again, checks the number, template and monthly budget,
                  and is skipped while the previous run is still sending. At most one run a day.
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Retry failed messages</Label>
                <Select
                  value={String(retryRounds)}
                  onValueChange={(v) => setRetryRounds(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Off</SelectItem>
                    <SelectItem value="1">1 round</SelectItem>
                    <SelectItem value="2">2 rounds</SelectItem>
                    <SelectItem value="3">3 rounds</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Only temporary errors are retried, never opt-outs or invalid numbers.
                </p>
              </div>
              {retryRounds > 0 && (
                <div className="grid gap-1.5">
                  <Label>Wait between rounds</Label>
                  <Select
                    value={String(retryDelay)}
                    onValueChange={(v) => setRetryDelay(Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RETRY_DELAYS.map((d) => (
                        <SelectItem key={d.v} value={String(d.v)}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Safety checks</summary>
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="c-fail">Pause when this % of sends fail</Label>
                  <Input
                    id="c-fail"
                    type="number"
                    min={1}
                    max={100}
                    value={maxFailure}
                    onChange={(e) =>
                      setMaxFailure(Math.min(100, Math.max(1, Number(e.target.value) || 1)))
                    }
                    className="w-20"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="c-quality">Pause if the number&apos;s quality rating drops</Label>
                  <Switch
                    id="c-quality"
                    checked={pauseOnQuality}
                    onCheckedChange={setPauseOnQuality}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  Campaigns also pause on sign-in or account errors, a paused number or a template
                  that is no longer approved, and always notify the team.
                </p>
              </div>
            </details>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-5 lg:sticky lg:top-4 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              {sample?.first_name
                ? "Filled with the first eligible recipient."
                : "Filled with the template's examples."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {abTemplate && (
              <div className="flex gap-2" role="group" aria-label="Version shown">
                {(["a", "b"] as const).map((sd) => (
                  <Button
                    key={sd}
                    type="button"
                    size="sm"
                    variant={previewSide === sd ? "default" : "outline"}
                    aria-pressed={previewSide === sd}
                    onClick={() => setPreviewSide(sd)}
                  >
                    Version {sd.toUpperCase()}
                  </Button>
                ))}
              </div>
            )}
            {phonePreview ? (
              <PhonePreview preview={phonePreview} />
            ) : (
              <p className="text-muted-foreground text-sm">Choose a template to see the message.</p>
            )}
            {resolved && resolved.missing.length > 0 && audienceReady && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Blank for the sample recipient: {resolved.missing.join(", ")}. Recipients with a
                blank value and no fallback are skipped.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Test</CardTitle>
            <CardDescription>Send this message to your own number first.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+971 50 123 4567"
              inputMode="tel"
              aria-label="Test phone number"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!shownTemplate || !testPhone.trim() || testing}
              onClick={test}
            >
              {testing ? <Loader2 className="animate-spin" /> : <Send />} Send
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          {problems.length > 0 && (
            <ul className="text-muted-foreground list-disc pl-5 text-xs">
              {problems.slice(0, 3).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <Button disabled={problems.length > 0 || creating || checking} onClick={start}>
            {creating && <Loader2 className="animate-spin" />}
            {mode === "repeat"
              ? "Save recurring campaign"
              : mode === "later"
                ? "Schedule campaign"
                : "Start campaign"}
          </Button>
        </div>
      </div>
      {askDialog}
    </div>
  );
}
