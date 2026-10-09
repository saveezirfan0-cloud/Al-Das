"use client";

import * as React from "react";
import { Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Filter } from "@/lib/filters/ast";
import {
  TRIGGER_LABEL,
  TRIGGER_TYPES,
  type TriggerConfig,
  type TriggerType,
} from "@/lib/flow-engine/types";

import { regenerateWebhookToken, updateFlowSettings } from "../actions";
import { ConditionsEditor, SelectField, TextField } from "./fields";
import type { BuilderLookups } from "./lookups";

export type FlowSettings = {
  name: string;
  description: string;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  conditions: Filter | null;
  channel_id: string | null;
};

export function SettingsDialog({
  open,
  onClose,
  flowId,
  value,
  lookups,
  hasWebhookToken,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  flowId: string;
  value: FlowSettings;
  lookups: BuilderLookups;
  hasWebhookToken: boolean;
  onSaved: (v: FlowSettings) => void;
}) {
  const [draft, setDraft] = React.useState<FlowSettings>(value);
  const [busy, setBusy] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setDraft(value);
      setToken(null);
    }
  }, [open, value]);

  const cfg = draft.trigger_config;
  const setCfg = (patch: Partial<TriggerConfig>) =>
    setDraft({ ...draft, trigger_config: { ...cfg, ...patch } });
  const t = draft.trigger_type;
  const hookUrl =
    token && typeof window !== "undefined"
      ? `${window.location.origin}/api/flows/hooks/${token}`
      : null;

  async function save() {
    setBusy(true);
    const r = await updateFlowSettings(flowId, {
      name: draft.name,
      description: draft.description || null,
      trigger_type: draft.trigger_type,
      trigger_config: Object.fromEntries(
        Object.entries(draft.trigger_config).filter(
          ([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
        ),
      ),
      conditions: draft.conditions,
      channel_id: draft.channel_id,
    });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Trigger settings saved.");
    onSaved(draft);
    onClose();
  }

  async function newToken() {
    const r = await regenerateWebhookToken(flowId);
    if (!r.ok) return void toast.error(r.error);
    setToken(r.data.token);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Trigger settings</DialogTitle>
          <DialogDescription>
            What starts this flow, and for which conversations. Changes apply to the next publish.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <TextField
            label="Name"
            value={draft.name}
            max={120}
            onChange={(v) => setDraft({ ...draft, name: v })}
          />
          <TextField
            label="Description"
            value={draft.description}
            max={500}
            multiline
            onChange={(v) => setDraft({ ...draft, description: v })}
          />
          <SelectField
            label="Starts when"
            value={t}
            onChange={(v) => v && setDraft({ ...draft, trigger_type: v as TriggerType })}
            options={TRIGGER_TYPES.map((x) => ({ value: x, label: TRIGGER_LABEL[x] }))}
          />
          <SelectField
            label="WhatsApp number"
            value={draft.channel_id ?? undefined}
            allowNone
            noneLabel="All numbers"
            onChange={(v) => setDraft({ ...draft, channel_id: v ?? null })}
            options={lookups.channels.map((c) => ({ value: c.id, label: c.name }))}
            help="Shortcut, conversation and button triggers only fire for this number. Flows that message patients on their own use it to open the conversation."
          />
          {t === "enquiry_added" ||
          t === "enquiry_stage_updated" ||
          t === "enquiry_status_updated" ? (
            <SelectField
              label="Pipeline"
              value={cfg.pipeline_id}
              allowNone
              noneLabel="Any pipeline"
              onChange={(v) => setCfg({ pipeline_id: v })}
              options={lookups.pipelines.map((p) => ({ value: p.id, label: p.name }))}
            />
          ) : null}
          {t === "recurring" ? (
            <div className="space-y-3">
              <TextField
                label="Schedule (cron)"
                value={cfg.cron ?? ""}
                mono
                onChange={(v) => setCfg({ cron: v })}
                placeholder="0 9 * * 1-5"
                help="Minute, hour, day of month, month, weekday. This flow runs without a patient: use it for API calls, tasks, notifications and portal records."
              />
              <TextField
                label="Time zone"
                value={cfg.timezone ?? ""}
                placeholder="Workspace time zone"
                onChange={(v) => setCfg({ timezone: v || undefined })}
              />
            </div>
          ) : null}
          {t === "template_button_reply" ? (
            <TextField
              label="Only for these buttons (comma separated, optional)"
              value={(cfg.button_ids ?? []).join(", ")}
              onChange={(v) =>
                setCfg({
                  button_ids: v
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
              help="Button ids or their text, e.g. Confirm, Reschedule. Empty = any button reply that is not an answer to a running question."
            />
          ) : null}
          {t === "incoming_webhook" ? (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Webhook address</span>
                <Button type="button" size="sm" variant="outline" onClick={newToken}>
                  <KeyRound className="size-3.5" />
                  {hasWebhookToken || token ? "Generate a new address" : "Generate address"}
                </Button>
              </div>
              {hookUrl ? (
                <>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted flex-1 overflow-x-auto rounded px-2 py-1.5 text-xs">
                      {hookUrl}
                    </code>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="size-8"
                      aria-label="Copy address"
                      onClick={() =>
                        navigator.clipboard.writeText(hookUrl).then(() => toast.success("Copied."))
                      }
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                  <Alert>
                    <AlertDescription>
                      Copy it now: the secret part is shown once. The old address stops working.
                    </AlertDescription>
                  </Alert>
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {hasWebhookToken
                    ? "An address exists; its secret is not shown again. Generate a new one to replace it."
                    : "Generate an address, then POST a JSON object to it. Include “phone” to link the run to an existing patient. Fields are available as {event.body.<name>}."}
                </p>
              )}
            </div>
          ) : null}
          {t !== "recurring" && t !== "shortcut" ? (
            <ConditionsEditor
              value={draft.conditions}
              onChange={(c) => setDraft({ ...draft, conditions: c })}
              title="Only start when…"
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !draft.name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
