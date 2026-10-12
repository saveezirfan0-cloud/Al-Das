"use client";

import { useEffect, useState, useTransition } from "react";
import { BellRing, Loader2, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pushSupport, urlBase64ToUint8Array, type PushSupport } from "@/lib/push/client";

import {
  registerPushSubscription,
  removePushDevice,
  sendTestPush,
  unregisterPushSubscription,
} from "./actions";

type Device = {
  id: string;
  ua_family: string | null;
  created_at: string;
  last_used_at: string | null;
};

const SUPPORT_TEXT: Record<Exclude<PushSupport, "supported">, string> = {
  no_service_worker: "This browser cannot run the background service Pulse needs for push.",
  no_push: "This browser does not support push notifications.",
  needs_install:
    "On iPhone and iPad, add Pulse to the Home Screen first (Share, then Add to Home Screen), then open it from there.",
  unknown: "Push support could not be checked.",
};

export function PushCard({
  vapidPublicKey,
  devices,
}: {
  vapidPublicKey: string | null;
  devices: Device[];
}) {
  const [pending, startTransition] = useTransition();
  const [support, setSupport] = useState<PushSupport>("unknown");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );
  const [subscribedHere, setSubscribedHere] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    setSupport(
      pushSupport({
        hasServiceWorker: "serviceWorker" in navigator,
        hasPushManager: "PushManager" in window,
        hasNotification: "Notification" in window,
        isIos: /iPhone|iPad|iPod/.test(ua),
        isStandalone:
          window.matchMedia("(display-mode: standalone)").matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      }),
    );
    if ("Notification" in window) setPermission(Notification.permission);
    void navigator.serviceWorker?.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribedHere(!!sub))
      .catch(() => {});
  }, []);

  function enable() {
    startTransition(async () => {
      try {
        const result = await Notification.requestPermission();
        setPermission(result);
        if (result !== "granted") {
          toast.error(
            "Notifications are blocked for this site. Allow them in the browser's site settings.",
          );
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!),
          }));
        const res = await registerPushSubscription({ subscription: sub.toJSON() });
        if (res.ok) {
          setSubscribedHere(true);
          toast.success(res.message ?? "Done.");
        } else toast.error(res.error);
      } catch {
        toast.error("Could not turn on push on this device.");
      }
    });
  }

  function disable() {
    startTransition(async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await unregisterPushSubscription(sub.endpoint);
          await sub.unsubscribe();
        }
        setSubscribedHere(false);
        toast.success("Push turned off on this device.");
      } catch {
        toast.error("Could not turn off push on this device.");
      }
    });
  }

  function test() {
    startTransition(async () => {
      const res = await sendTestPush();
      if (res.ok) toast.success(res.message ?? "Sent.");
      else toast.error(res.error);
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await removePushDevice(id);
      if (res.ok) toast.success(res.message ?? "Removed.");
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4" /> Push notifications on your devices
        </CardTitle>
        <CardDescription>
          Pulse can ping this phone or computer when a message, assignment or task needs you, even
          with the app closed. The message only says that something needs you; open Pulse to see
          what.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!vapidPublicKey ? (
          <p className="text-muted-foreground text-sm" role="status">
            Push is not set up on this server yet. An administrator needs to run{" "}
            <code>pnpm push:keys</code> and add the VAPID keys to the environment. In-app and e-mail
            notifications work without it.
          </p>
        ) : support !== "supported" ? (
          <p className="text-muted-foreground text-sm" role="status">
            {support === "unknown" ? "Checking this device…" : SUPPORT_TEXT[support]}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {subscribedHere && permission === "granted" ? (
              <>
                <Button variant="outline" onClick={disable} disabled={pending}>
                  Turn off on this device
                </Button>
                <Button onClick={test} disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />} Send me a test
                </Button>
              </>
            ) : (
              <Button onClick={enable} disabled={pending}>
                {pending && <Loader2 className="animate-spin" />} Turn on push on this device
              </Button>
            )}
            {permission === "denied" && (
              <span className="text-destructive text-sm">
                Blocked in this browser&apos;s site settings.
              </span>
            )}
          </div>
        )}

        {devices.length > 0 && (
          <ul className="divide-y rounded-md border text-sm" aria-label="Registered devices">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <Smartphone className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="truncate">{d.ua_family ?? "Device"}</span>
                  <span className="text-muted-foreground hidden text-xs sm:inline">
                    added {new Date(d.created_at).toLocaleDateString()}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${d.ua_family ?? "device"}`}
                  onClick={() => remove(d.id)}
                  disabled={pending}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
