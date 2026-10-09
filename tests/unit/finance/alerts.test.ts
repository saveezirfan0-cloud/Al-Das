import { describe, expect, it } from "vitest";

import {
  evaluateAlerts,
  planAlertNotifications,
  type Alert,
  type AlertSnapshot,
  type AlertState,
} from "@/lib/finance/alerts";
import { runAlerts, type AlertDeps } from "@/lib/finance/run-alerts";

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const healthy = (over: Partial<AlertSnapshot> = {}): AlertSnapshot => ({
  captureEnabled: true,
  lastSuccessfulCaptureAt: ago(0.5),
  settingsUpdatedAt: ago(500),
  failedOrPendingBatches: 0,
  openCaptureExceptions: 0,
  balanceStalled: false,
  lastDiligenceUploadAt: ago(24 * 3),
  everUploaded: true,
  overdueExceptions: 0,
  ...over,
});
const keys = (s: AlertSnapshot) => evaluateAlerts(s, NOW).map((a) => `${a.key}:${a.severity}`);

describe("evaluateAlerts", () => {
  it("is quiet when everything is healthy", () => {
    expect(keys(healthy())).toEqual([]);
  });

  it("raises capture_failed (critical) for unprocessed batches or open capture exceptions", () => {
    expect(keys(healthy({ failedOrPendingBatches: 1 }))).toEqual(["capture_failed:critical"]);
    expect(keys(healthy({ openCaptureExceptions: 2 }))).toEqual(["capture_failed:critical"]);
  });

  it("raises capture_stalled only while capture is on", () => {
    expect(keys(healthy({ balanceStalled: true }))).toEqual(["capture_stalled:critical"]);
    expect(
      keys(healthy({ balanceStalled: true, captureEnabled: false, everUploaded: false })),
    ).toEqual([]);
  });

  it("capture_silent: warning after 3 h, critical after 6 h, exact boundaries", () => {
    expect(keys(healthy({ lastSuccessfulCaptureAt: ago(3) }))).toEqual([]);
    expect(keys(healthy({ lastSuccessfulCaptureAt: ago(3.1) }))).toEqual([
      "capture_silent:warning",
    ]);
    expect(keys(healthy({ lastSuccessfulCaptureAt: ago(6) }))).toEqual(["capture_silent:warning"]);
    expect(keys(healthy({ lastSuccessfulCaptureAt: ago(6.1) }))).toEqual([
      "capture_silent:critical",
    ]);
  });

  it("capture_silent counts from the settings change while nothing has been captured yet", () => {
    expect(keys(healthy({ lastSuccessfulCaptureAt: null, settingsUpdatedAt: ago(0.2) }))).toEqual(
      [],
    ); // just switched on
    expect(keys(healthy({ lastSuccessfulCaptureAt: null, settingsUpdatedAt: ago(7) }))).toEqual([
      "capture_silent:critical",
    ]);
    expect(
      keys(
        healthy({
          captureEnabled: false,
          lastSuccessfulCaptureAt: null,
          settingsUpdatedAt: ago(70),
          everUploaded: false,
        }),
      ),
    ).toEqual([]);
  });

  it("no_diligence_upload: after 8 days, only when the module is in use", () => {
    expect(keys(healthy({ lastDiligenceUploadAt: ago(24 * 8) }))).toEqual([]);
    expect(keys(healthy({ lastDiligenceUploadAt: ago(24 * 8 + 1) }))).toEqual([
      "no_diligence_upload:warning",
    ]);
    // capture on, no upload ever: counts from the settings date
    expect(
      keys(
        healthy({
          lastDiligenceUploadAt: null,
          everUploaded: false,
          settingsUpdatedAt: ago(24 * 9),
        }),
      ),
    ).toEqual(["no_diligence_upload:warning"]);
    expect(
      keys(
        healthy({
          lastDiligenceUploadAt: null,
          everUploaded: false,
          settingsUpdatedAt: ago(24 * 2),
        }),
      ),
    ).toEqual([]);
    // not in use at all
    expect(
      keys(
        healthy({
          captureEnabled: false,
          everUploaded: false,
          lastDiligenceUploadAt: null,
          settingsUpdatedAt: ago(24 * 90),
        }),
      ),
    ).toEqual([]);
    // uploads without capture still need the weekly cadence
    expect(keys(healthy({ captureEnabled: false, lastDiligenceUploadAt: ago(24 * 20) }))).toEqual([
      "no_diligence_upload:warning",
    ]);
  });

  it("overdue_exceptions is informational and only above 20", () => {
    expect(keys(healthy({ overdueExceptions: 20 }))).toEqual([]);
    expect(keys(healthy({ overdueExceptions: 21 }))).toEqual(["overdue_exceptions:info"]);
  });

  it("messages carry counts and times, never identifiers", () => {
    const all = evaluateAlerts(
      healthy({
        failedOrPendingBatches: 3,
        openCaptureExceptions: 1,
        balanceStalled: true,
        lastSuccessfulCaptureAt: ago(9),
        lastDiligenceUploadAt: ago(24 * 30),
        overdueExceptions: 50,
      }),
      NOW,
    );
    expect(all.map((a) => a.key).sort()).toEqual([
      "capture_failed",
      "capture_silent",
      "capture_stalled",
      "no_diligence_upload",
      "overdue_exceptions",
    ]);
    for (const a of all) expect(a.title + a.body).not.toMatch(/ADMC|\bPIN\b|batch [0-9a-f]{8}/i);
  });
});

describe("planAlertNotifications", () => {
  const alert = (key: string, severity: Alert["severity"] = "critical"): Alert => ({
    key,
    severity,
    title: key,
    body: "b",
  });
  const state = (key: string, over: Partial<AlertState> = {}): AlertState => ({
    alert_key: key,
    severity: "critical",
    first_seen_at: ago(48),
    last_notified_at: ago(1),
    cleared_at: null,
    ...over,
  });

  it("announces a new alert once", () => {
    const first = planAlertNotifications([alert("capture_failed")], [], NOW);
    expect(first.notify).toEqual([{ alert: alert("capture_failed"), kind: "new" }]);
    expect(first.state[0]).toMatchObject({
      alert_key: "capture_failed",
      last_notified_at: NOW.toISOString(),
      cleared_at: null,
    });
    const second = planAlertNotifications(
      [alert("capture_failed")],
      first.state,
      new Date(NOW.getTime() + 3_600_000),
    );
    expect(second.notify).toEqual([]);
    expect(second.state).toEqual([]);
  });

  it("reminds after 24 h for warning and critical, never for info", () => {
    expect(
      planAlertNotifications([alert("a")], [state("a", { last_notified_at: ago(24) })], NOW)
        .notify[0].kind,
    ).toBe("reminder");
    expect(
      planAlertNotifications([alert("a")], [state("a", { last_notified_at: ago(23.9) })], NOW)
        .notify,
    ).toEqual([]);
    expect(
      planAlertNotifications(
        [alert("o", "info")],
        [state("o", { severity: "info", last_notified_at: ago(100) })],
        NOW,
      ).notify,
    ).toEqual([]);
  });

  it("announces a worsening, and downgrades quietly", () => {
    const worse = planAlertNotifications(
      [alert("s", "critical")],
      [state("s", { severity: "warning" })],
      NOW,
    );
    expect(worse.notify[0].kind).toBe("worsened");
    const better = planAlertNotifications(
      [alert("s", "warning")],
      [state("s", { severity: "critical" })],
      NOW,
    );
    expect(better.notify).toEqual([]);
    expect(better.state[0].severity).toBe("warning");
  });

  it("clears gone alerts and sends a resolved notice only for critical ones", () => {
    const plan = planAlertNotifications(
      [],
      [
        state("capture_failed"),
        state("no_diligence_upload", { severity: "warning" }),
        state("old", { cleared_at: ago(5) }),
      ],
      NOW,
    );
    expect(plan.resolved).toEqual([{ key: "capture_failed" }]);
    expect(plan.state.map((s) => [s.alert_key, s.cleared_at !== null])).toEqual([
      ["capture_failed", true],
      ["no_diligence_upload", true],
    ]);
  });

  it("a cleared alert that comes back is new again", () => {
    const plan = planAlertNotifications([alert("a")], [state("a", { cleared_at: ago(5) })], NOW);
    expect(plan.notify[0].kind).toBe("new");
    expect(plan.state[0].cleared_at).toBeNull();
  });
});

describe("runAlerts", () => {
  function deps(snapshot: AlertSnapshot, prior: AlertState[] = []) {
    const log = { inApp: [] as string[], email: [] as string[], saved: [] as AlertState[][] };
    const d: AlertDeps = {
      now: () => NOW,
      loadSnapshot: async () => snapshot,
      loadState: async () => prior,
      saveState: async (rows) => void log.saved.push(rows),
      notifyInApp: async (n) => void log.inApp.push(n.title),
      notifyEmail: async (n) => void log.email.push(n.subject),
    };
    return { d, log };
  }

  it("critical alerts go in-app and by e-mail, warnings in-app only, then state is saved", async () => {
    const { d, log } = deps(
      healthy({ failedOrPendingBatches: 1, lastDiligenceUploadAt: ago(24 * 30) }),
    );
    const res = await runAlerts(d);
    expect(res).toEqual({ active: 2, notified: 2, resolved: 0 });
    expect(log.inApp).toHaveLength(2);
    expect(log.email).toEqual(["[Finance] Unite capture needs attention"]);
    expect(log.saved[0].map((s) => s.alert_key).sort()).toEqual([
      "capture_failed",
      "no_diligence_upload",
    ]);
  });

  it("is silent on a repeat run and sends one resolved notice when a critical alert clears", async () => {
    const first = deps(healthy({ failedOrPendingBatches: 1 }));
    await runAlerts(first.d);
    const prior = first.log.saved[0];

    const repeat = deps(healthy({ failedOrPendingBatches: 1 }), prior);
    expect((await runAlerts(repeat.d)).notified).toBe(0);
    expect(repeat.log.saved).toEqual([]);

    const fixed = deps(healthy(), prior);
    const res = await runAlerts(fixed.d);
    expect(res).toMatchObject({ active: 0, resolved: 1 });
    expect(fixed.log.inApp).toEqual(["Unite capture is working again"]);
    expect(fixed.log.email).toEqual(["[Finance] Unite capture is working again"]);
  });

  it("does not remember an alert whose notification failed, so the next hour retries", async () => {
    const { d, log } = deps(healthy({ failedOrPendingBatches: 1 }));
    d.notifyInApp = async () => {
      throw new Error("db down");
    };
    await expect(runAlerts(d)).rejects.toThrow("db down");
    expect(log.saved).toEqual([]);
  });
});
