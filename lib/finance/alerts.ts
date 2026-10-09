/**
 * Monitoring alerts for the finance module. Pure: evaluate a snapshot, then plan who to tell.
 * Texts carry counts and times only, never invoice numbers, claim numbers or patient data.
 */

export type Severity = "info" | "warning" | "critical";
const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export type Alert = { key: string; severity: Severity; title: string; body: string };

export type AlertSnapshot = {
  captureEnabled: boolean;
  /** Last time capture finished a batch successfully (empty pages count). */
  lastSuccessfulCaptureAt: string | null;
  /** When capture settings last changed: the reference point while nothing has happened yet. */
  settingsUpdatedAt: string;
  failedOrPendingBatches: number;
  openCaptureExceptions: number;
  balanceStalled: boolean;
  lastDiligenceUploadAt: string | null;
  everUploaded: boolean;
  overdueExceptions: number;
};

export const SILENT_WARNING_HOURS = 3;
export const SILENT_CRITICAL_HOURS = 6;
export const UPLOAD_MAX_DAYS = 8;
export const OVERDUE_NOTICE_THRESHOLD = 20;
export const REMINDER_HOURS = 24;

const hoursBetween = (a: string | Date, b: Date) =>
  (b.getTime() - new Date(a).getTime()) / 3_600_000;

export function evaluateAlerts(s: AlertSnapshot, now = new Date()): Alert[] {
  const out: Alert[] = [];

  if (s.failedOrPendingBatches > 0 || s.openCaptureExceptions > 0) {
    out.push({
      key: "capture_failed",
      severity: "critical",
      title: "Unite capture needs attention",
      body: `${s.failedOrPendingBatches} batch(es) are unprocessed or failed and ${s.openCaptureExceptions} capture exception(s) are open. New records are not pulled until earlier batches are processed. Open Finance → Data health.`,
    });
  }

  if (s.captureEnabled && s.balanceStalled) {
    out.push({
      key: "capture_stalled",
      severity: "critical",
      title: "Unite remaining balance is not dropping",
      body: "Recent batches returned records but the number still waiting at Unite did not go down. Check the batch log before the next run and raise it with Unite.",
    });
  }

  if (s.captureEnabled) {
    const ref = s.lastSuccessfulCaptureAt ?? s.settingsUpdatedAt;
    const h = hoursBetween(ref, now);
    if (h > SILENT_WARNING_HOURS) {
      out.push({
        key: "capture_silent",
        severity: h > SILENT_CRITICAL_HOURS ? "critical" : "warning",
        title: "Unite capture has gone quiet",
        body: `Capture is switched on but nothing has been captured for about ${Math.floor(h)} hours (it should run every hour). Check System health and the credentials.`,
      });
    }
  }

  const inUse = s.captureEnabled || s.everUploaded;
  if (inUse) {
    const ref = s.lastDiligenceUploadAt ?? s.settingsUpdatedAt;
    const days = hoursBetween(ref, now) / 24;
    if (days > UPLOAD_MAX_DAYS) {
      out.push({
        key: "no_diligence_upload",
        severity: "warning",
        title: "No Diligence claims upload in over 8 days",
        body: `The last claims upload was about ${Math.floor(days)} days ago. Claim statuses, ageing and insurance exceptions are only as fresh as the last upload. Sharaf: Finance → Insurance upload.`,
      });
    }
  }

  if (s.overdueExceptions > OVERDUE_NOTICE_THRESHOLD) {
    out.push({
      key: "overdue_exceptions",
      severity: "info",
      title: "Many finance exceptions are overdue",
      body: `${s.overdueExceptions} exceptions are past their due date. Open Finance → Exceptions, filter on overdue.`,
    });
  }

  return out;
}

export type AlertState = {
  alert_key: string;
  severity: Severity;
  first_seen_at: string;
  last_notified_at: string | null;
  cleared_at: string | null;
};

export type AlertPlan = {
  notify: Array<{ alert: Alert; kind: "new" | "worsened" | "reminder" }>;
  /** Critical alerts that cleared since the last run: send one "resolved" notice. */
  resolved: Array<{ key: string }>;
  /** Full desired state for the alerts touched this run (upsert by key). */
  state: AlertState[];
};

/** Decide what to announce. Quiet when nothing changed; reminders only for warning / critical. */
export function planAlertNotifications(
  active: readonly Alert[],
  previous: readonly AlertState[],
  now = new Date(),
): AlertPlan {
  const iso = now.toISOString();
  const prevByKey = new Map(previous.map((p) => [p.alert_key, p]));
  const notify: AlertPlan["notify"] = [];
  const resolved: AlertPlan["resolved"] = [];
  const state: AlertState[] = [];

  for (const alert of active) {
    const prev = prevByKey.get(alert.key);
    if (!prev || prev.cleared_at) {
      notify.push({ alert, kind: "new" });
      state.push({
        alert_key: alert.key,
        severity: alert.severity,
        first_seen_at: iso,
        last_notified_at: iso,
        cleared_at: null,
      });
      continue;
    }
    if (RANK[alert.severity] > RANK[prev.severity]) {
      notify.push({ alert, kind: "worsened" });
      state.push({ ...prev, severity: alert.severity, last_notified_at: iso });
      continue;
    }
    const due =
      alert.severity !== "info" &&
      (!prev.last_notified_at || hoursBetween(prev.last_notified_at, now) >= REMINDER_HOURS);
    if (due) {
      notify.push({ alert, kind: "reminder" });
      state.push({ ...prev, severity: alert.severity, last_notified_at: iso });
    } else if (prev.severity !== alert.severity) {
      state.push({ ...prev, severity: alert.severity }); // quiet downgrade
    }
  }

  const activeKeys = new Set(active.map((a) => a.key));
  for (const prev of previous) {
    if (prev.cleared_at || activeKeys.has(prev.alert_key)) continue;
    state.push({ ...prev, cleared_at: iso });
    if (prev.severity === "critical") resolved.push({ key: prev.alert_key });
  }

  return { notify, resolved, state };
}

export const RESOLVED_TITLES: Record<string, string> = {
  capture_failed: "Unite capture is working again",
  capture_stalled: "Unite remaining balance is dropping again",
  capture_silent: "Unite capture is running again",
};
