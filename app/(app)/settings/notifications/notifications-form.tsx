"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  CHANNEL_LABELS,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from "@/lib/notify/events";
import { effectiveSetting, type PrefRow } from "@/lib/notify/preferences";

import { savePreferences } from "./actions";

type EventRow = {
  key: string;
  group: string;
  label: string;
  description: string;
  channels: NotificationChannel[];
  defaults: Record<NotificationChannel, boolean>;
};

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");

export function NotificationsForm({ events, prefs }: { events: EventRow[]; prefs: PrefRow[] }) {
  const [pending, startTransition] = useTransition();

  const [toggles, setToggles] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const e of events)
      for (const c of e.channels) out[`${e.key}:${c}`] = effectiveSetting(e.key, c, prefs);
    return out;
  });
  const [channels, setChannels] = useState(
    () =>
      Object.fromEntries(
        NOTIFICATION_CHANNELS.map((c) => {
          const master = prefs.find((p) => p.event === "*" && p.channel === c);
          return [
            c,
            {
              enabled: master ? master.enabled : true,
              start: hhmm(master?.quiet_start),
              end: hhmm(master?.quiet_end),
            },
          ];
        }),
      ) as Record<NotificationChannel, { enabled: boolean; start: string; end: string }>,
  );

  const groups = useMemo(() => {
    const map = new Map<string, EventRow[]>();
    for (const e of events) map.set(e.group, [...(map.get(e.group) ?? []), e]);
    return [...map.entries()];
  }, [events]);

  function save() {
    startTransition(async () => {
      const res = await savePreferences({
        toggles: events.flatMap((e) =>
          e.channels.map((c) => ({ event: e.key, channel: c, enabled: toggles[`${e.key}:${c}`] })),
        ),
        channels: NOTIFICATION_CHANNELS.map((c) => ({
          channel: c,
          enabled: channels[c].enabled,
          quiet_start:
            c !== "in_app" && channels[c].start && channels[c].end ? channels[c].start : null,
          quiet_end:
            c !== "in_app" && channels[c].start && channels[c].end ? channels[c].end : null,
        })),
      });
      if (res.ok) toast.success(res.message ?? "Saved.");
      else toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What to tell me, and where</CardTitle>
          <CardDescription>
            Push and e-mail only ever carry a short generic sentence and a link, never a patient
            name or message text.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-2 sm:grid-cols-3">
            {NOTIFICATION_CHANNELS.map((c) => (
              <div
                key={c}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <span className="font-medium">{CHANNEL_LABELS[c]}</span>
                <Switch
                  aria-label={`${CHANNEL_LABELS[c]} master switch`}
                  checked={channels[c].enabled}
                  onCheckedChange={(v) =>
                    setChannels((s) => ({ ...s, [c]: { ...s[c], enabled: v } }))
                  }
                />
              </div>
            ))}
          </div>

          {groups.map(([group, rows]) => (
            <section key={group} aria-label={group} className="flex flex-col gap-1">
              <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                {group}
              </h3>
              <div className="divide-y rounded-md border">
                {rows.map((e) => (
                  <div
                    key={e.key}
                    className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{e.label}</p>
                      <p className="text-muted-foreground text-xs">{e.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      {NOTIFICATION_CHANNELS.map((c) =>
                        e.channels.includes(c) ? (
                          <label key={c} className="flex min-h-11 items-center gap-2 text-xs">
                            <Switch
                              checked={toggles[`${e.key}:${c}`] && channels[c].enabled}
                              disabled={!channels[c].enabled}
                              onCheckedChange={(v) =>
                                setToggles((s) => ({ ...s, [`${e.key}:${c}`]: v }))
                              }
                              aria-label={`${e.label}: ${CHANNEL_LABELS[c]}`}
                            />
                            <span className="text-muted-foreground">{CHANNEL_LABELS[c]}</span>
                          </label>
                        ) : null,
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quiet hours</CardTitle>
          <CardDescription>
            Between these times, push and e-mail are held back (the notification stays in the app).
            Escalations for conversations nobody has picked up still come through. Times are in your
            own time zone.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {(["push", "email"] as const).map((c) => (
            <fieldset key={c} className="flex flex-col gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{CHANNEL_LABELS[c]}</legend>
              <div className="flex items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  From
                  <Input
                    type="time"
                    className="w-32"
                    value={channels[c].start}
                    onChange={(e) =>
                      setChannels((s) => ({ ...s, [c]: { ...s[c], start: e.target.value } }))
                    }
                  />
                </label>
                <label className="flex items-center gap-2">
                  to
                  <Input
                    type="time"
                    className="w-32"
                    value={channels[c].end}
                    onChange={(e) =>
                      setChannels((s) => ({ ...s, [c]: { ...s[c], end: e.target.value } }))
                    }
                  />
                </label>
              </div>
              {(channels[c].start || channels[c].end) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setChannels((s) => ({ ...s, [c]: { ...s[c], start: "", end: "" } }))
                  }
                >
                  Clear quiet hours
                </Button>
              )}
            </fieldset>
          ))}
        </CardContent>
      </Card>

      <div>
        <Button onClick={save} disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save notification settings
        </Button>
      </div>
    </div>
  );
}
