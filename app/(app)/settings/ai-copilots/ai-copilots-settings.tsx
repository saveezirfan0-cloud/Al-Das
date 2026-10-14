"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  FLOW_TRIGGERABLE_TAGS,
  TAG_FLOWS_CONFIRM_PHRASE,
  type FlowTriggerableTag,
} from "@/lib/ai/copilot/settings";
import { INTENT_LABELS } from "@/lib/ai/intent/labels";

import { disableTagFlows, enableTagFlows, saveIntentDetection, type ActionResult } from "./actions";

const FEATURES: Array<{ key: string; label: string }> = [
  { key: "flow_copilot", label: "Flow Copilot drafts" },
  { key: "campaign_audience", label: "Campaign audiences" },
  { key: "campaign_copy", label: "Template wording" },
  { key: "intent", label: "Messages labelled" },
];

function useRun() {
  const [pending, start] = useTransition();
  function run(fn: () => Promise<ActionResult>, after?: () => void) {
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        after?.();
      } else toast.error(r.error);
    });
  }
  return { pending, run };
}

export function AiCopilotsSettings({
  aiEnabled,
  intentDetection,
  tagFlows,
  canAdmin,
  canSign,
  usage,
}: {
  aiEnabled: boolean;
  intentDetection: boolean;
  tagFlows: {
    enabled: boolean;
    tags: FlowTriggerableTag[];
    signed_at: string | null;
    signedByName: string | null;
  };
  canAdmin: boolean;
  canSign: boolean;
  usage: Record<string, { calls: number; problems: number }>;
}) {
  const [ask, askDialog] = useConfirm();
  const { pending, run } = useRun();
  const [phrase, setPhrase] = useState("");
  const [tags, setTags] = useState<FlowTriggerableTag[]>(tagFlows.tags);

  return (
    <div className="flex flex-col gap-6">
      {!aiEnabled && (
        <Alert>
          <AlertTitle>AI assist is off for this workspace</AlertTitle>
          <AlertDescription>
            The copilots and message labelling need it. An administrator turns it on under Settings,
            AI &amp; knowledge base, after the data-handling question there has been answered.
            Emergency wording is still checked while it is off.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Emergency wording</CardTitle>
          <CardDescription>
            Always on, with or without AI. When a patient&apos;s message contains wording such as
            chest pain, trouble breathing, heavy bleeding or thoughts of self-harm (English and
            Arabic), the conversation is tagged, any bot stops, and the owner, the team lead and the
            on-call people are told at once. Push and e-mail say only that a message needs
            attention. It is a prompt to look, not a diagnosis, and it can miss unusual spellings or
            voice notes: never rely on it instead of watching the inbox.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Label inbound messages with AI{" "}
            <Badge variant={intentDetection ? "success" : "outline"}>
              {intentDetection ? "On" : "Off"}
            </Badge>
          </CardTitle>
          <CardDescription>
            Each inbound text message (phone numbers and e-mail addresses masked, names and
            everything else unchanged) is sent to the AI provider to be labelled wants to book,
            asking about price, complaint, asking for a report, or possible emergency. Labels appear
            on the conversation; they never send anything. This sends every inbound message, so
            confirm it fits your data-residency and consent position first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <Label htmlFor="intent-switch">Label messages with AI</Label>
          <Switch
            id="intent-switch"
            checked={intentDetection}
            disabled={!canAdmin || pending || (!aiEnabled && !intentDetection)}
            onCheckedChange={(v) => run(() => saveIntentDetection(v))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            AI tags starting flows{" "}
            <Badge variant={tagFlows.enabled ? "success" : "outline"}>
              {tagFlows.enabled ? "Approved" : "Off"}
            </Badge>
          </CardTitle>
          <CardDescription>
            A flow can start when the AI adds a tag such as &quot;wants to book&quot;. A wrong tag
            then sends a patient a message nobody chose, so this needs the clinical lead&apos;s
            approval. A possible emergency never starts a flow: it always goes to a person.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {tagFlows.enabled ? (
            <>
              <p className="text-muted-foreground text-sm">
                Approved for: {tagFlows.tags.map((t) => INTENT_LABELS[t]).join(", ")}
                {tagFlows.signedByName ? ` by ${tagFlows.signedByName}` : ""}
                {tagFlows.signed_at ? ` on ${new Date(tagFlows.signed_at).toLocaleString()}` : ""}.
              </p>
              {(canSign || canAdmin) && (
                <Button
                  variant="outline"
                  className="w-fit"
                  disabled={pending}
                  onClick={async () => {
                    if (await ask("Stop AI tags from starting flows?"))
                      run(() => disableTagFlows());
                  }}
                >
                  Withdraw the approval
                </Button>
              )}
            </>
          ) : canSign ? (
            <form
              className="grid max-w-md gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                run(
                  () => enableTagFlows({ tags, phrase }),
                  () => setPhrase(""),
                );
              }}
            >
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-sm font-medium">Tags that may start a flow</legend>
                {FLOW_TRIGGERABLE_TAGS.map((tag) => (
                  <label key={tag} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={tags.includes(tag)}
                      onChange={(e) =>
                        setTags(e.target.checked ? [...tags, tag] : tags.filter((t) => t !== tag))
                      }
                    />
                    {INTENT_LABELS[tag]}
                  </label>
                ))}
              </fieldset>
              <Label htmlFor="tag-flows-phrase">
                Type <code>{TAG_FLOWS_CONFIRM_PHRASE}</code> to approve
              </Label>
              <Input
                id="tag-flows-phrase"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
              />
              <Button
                type="submit"
                className="w-fit"
                disabled={
                  pending ||
                  tags.length === 0 ||
                  phrase.trim() !== TAG_FLOWS_CONFIRM_PHRASE ||
                  !intentDetection ||
                  !aiEnabled
                }
              >
                Approve
              </Button>
              {(!intentDetection || !aiEnabled) && (
                <p className="text-muted-foreground text-xs">
                  Turn on AI assist and AI labelling above first.
                </p>
              )}
            </form>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only the person who signs off clinical settings (the clinical lead) can approve this.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>This month</CardTitle>
          <CardDescription>
            Calls to the AI provider by these features. Counts only: no prompts or replies are kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.key}>
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="text-lg font-semibold">{usage[f.key]?.calls ?? 0}</dd>
                {(usage[f.key]?.problems ?? 0) > 0 && (
                  <dd className="text-muted-foreground text-xs">
                    {usage[f.key]!.problems} refused, failed or rejected
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      {askDialog}
    </div>
  );
}
