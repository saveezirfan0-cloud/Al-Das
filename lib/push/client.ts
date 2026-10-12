/** Browser-side helpers for Web Push. No server imports: this file ships to the client. */

/** VAPID public keys are URL-safe base64; pushManager.subscribe wants raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushSupport =
  "supported" | "no_service_worker" | "no_push" | "needs_install" | "unknown";

/** iOS only offers Web Push to installed (home-screen) apps, so say that instead of "unsupported". */
export function pushSupport(env: {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  isStandalone: boolean;
}): PushSupport {
  if (env.isIos && !env.isStandalone) return "needs_install";
  if (!env.hasServiceWorker) return "no_service_worker";
  if (!env.hasPushManager || !env.hasNotification) return "no_push";
  return "supported";
}
