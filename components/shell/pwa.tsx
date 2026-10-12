"use client";

import { useCallback, useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { toast } from "sonner";

/**
 * Registers the service worker (production only: a worker in `next dev` caches stale code), offers the
 * "new version" prompt, and shows a strip while the device is offline. The worker only caches static assets
 * and an offline page; it never stores patient data (see public/sw.js).
 */
export function PwaRuntime() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    const promptUpdate = (worker: ServiceWorker) =>
      toast("A new version of Pulse is ready", {
        id: "pwa-update",
        duration: Infinity,
        action: {
          label: "Update now",
          onClick: () => worker.postMessage({ type: "SKIP_WAITING" }),
        },
      });

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        // A worker that was already waiting when the page loaded.
        if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller)
              promptUpdate(installing);
          });
        });
        // Look for a new version when the app is brought back to the front.
        const check = () =>
          document.visibilityState === "visible" && void reg.update().catch(() => {});
        document.addEventListener("visibilitychange", check);
      })
      .catch(() => {
        /* registration can fail in private windows or on http: the app works without it */
      });
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () =>
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-3 py-1.5 text-center text-sm font-medium text-black"
    >
      <WifiOff className="size-4" aria-hidden /> You are offline. Changes will not save until the
      connection returns.
    </div>
  );
}

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** "Install app": the browser's own prompt where available, and a hint for iOS Safari, which has none. */
export function usePwaInstall() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice.catch(() => {});
      setDeferred(null);
    } else if (ios) {
      toast("To install Pulse on iPhone or iPad", {
        description: "Tap the Share button in Safari, then choose Add to Home Screen.",
        duration: 10_000,
      });
    }
  }, [deferred, ios]);

  return { canInstall: !installed && (!!deferred || ios), install };
}
