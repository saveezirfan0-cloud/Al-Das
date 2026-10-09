/**
 * The 24-hour customer-service window. Free-form messages are allowed only
 * within 24h of the last inbound message; otherwise an approved template is
 * required. Click-to-WhatsApp ad conversations get a 72h free-entry window.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FREE_ENTRY_WINDOW_MS = 72 * 60 * 60 * 1000;

export type WindowInput = {
  lastInboundAt: Date | string | null | undefined;
  /** When the conversation opened from a CTWA ad (ad_referral present). */
  adOpenedAt?: Date | string | null;
  now?: Date;
};

export type WindowState = {
  open: boolean;
  /** Milliseconds until the window closes (0 when closed). */
  remainingMs: number;
  closesAt: Date | null;
  reason: "service" | "free_entry" | "closed" | "never_inbound";
};

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function serviceWindow(input: WindowInput): WindowState {
  const now = (input.now ?? new Date()).getTime();
  const inbound = toMs(input.lastInboundAt);
  const ad = toMs(input.adOpenedAt);

  const candidates: Array<{ closesAt: number; reason: "service" | "free_entry" }> = [];
  if (inbound !== null)
    candidates.push({ closesAt: inbound + SERVICE_WINDOW_MS, reason: "service" });
  if (ad !== null) candidates.push({ closesAt: ad + FREE_ENTRY_WINDOW_MS, reason: "free_entry" });

  if (candidates.length === 0) {
    return { open: false, remainingMs: 0, closesAt: null, reason: "never_inbound" };
  }
  const best = candidates.reduce((a, b) => (b.closesAt > a.closesAt ? b : a));
  const remaining = best.closesAt - now;
  if (remaining <= 0) {
    return { open: false, remainingMs: 0, closesAt: new Date(best.closesAt), reason: "closed" };
  }
  return {
    open: true,
    remainingMs: remaining,
    closesAt: new Date(best.closesAt),
    reason: best.reason,
  };
}

/** True when a free-form (non-template) message may be sent right now. */
export function canSendFreeForm(input: WindowInput): boolean {
  return serviceWindow(input).open;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "closed";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
