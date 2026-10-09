import {
  RESOLVED_TITLES,
  evaluateAlerts,
  planAlertNotifications,
  type Alert,
  type AlertSnapshot,
  type AlertState,
} from "@/lib/finance/alerts";

export type AlertDeps = {
  now(): Date;
  loadSnapshot(): Promise<AlertSnapshot>;
  loadState(): Promise<AlertState[]>;
  saveState(rows: AlertState[]): Promise<void>;
  /** In-app notification to everyone holding finance.capture.manage. */
  notifyInApp(n: { title: string; body: string; key: string; severity: string }): Promise<void>;
  /** E-mail to the same people (critical and resolved notices only). */
  notifyEmail(n: { subject: string; text: string }): Promise<void>;
};

export type AlertRunResult = { active: number; notified: number; resolved: number };

/** Evaluate, decide, announce, remember. State is saved last so a failed send is retried next hour. */
export async function runAlerts(deps: AlertDeps): Promise<AlertRunResult> {
  const now = deps.now();
  const active = evaluateAlerts(await deps.loadSnapshot(), now);
  const plan = planAlertNotifications(active, await deps.loadState(), now);

  const prefix = (a: Alert, kind: string) =>
    kind === "reminder" ? "Reminder: " : kind === "worsened" ? "Worse: " : "";
  for (const { alert, kind } of plan.notify) {
    const title = `${prefix(alert, kind)}${alert.title}`;
    await deps.notifyInApp({ title, body: alert.body, key: alert.key, severity: alert.severity });
    if (alert.severity === "critical")
      await deps.notifyEmail({ subject: `[Finance] ${title}`, text: alert.body });
  }
  for (const r of plan.resolved) {
    const title = RESOLVED_TITLES[r.key] ?? "A finance alert has cleared";
    await deps.notifyInApp({
      title,
      body: "The problem is no longer detected.",
      key: r.key,
      severity: "info",
    });
    await deps.notifyEmail({
      subject: `[Finance] ${title}`,
      text: "The problem is no longer detected.",
    });
  }
  if (plan.state.length > 0) await deps.saveState(plan.state);
  return { active: active.length, notified: plan.notify.length, resolved: plan.resolved.length };
}
