/** Pure: turns a handful of counts into the "what is still to set up" checklist. */

export type ReadinessInput = {
  credentialsConfigured: boolean;
  captureEnabled: boolean;
  batchCount: number;
  invoiceCount: number;
  claimCount: number;
  branchesMapped: number;
  activeRules: number;
  lastImportAt: string | null;
};

export type StepState = "done" | "todo" | "blocked";
export type ReadinessStep = {
  key: string;
  label: string;
  state: StepState;
  hint: string;
  /** Portal path where the step is completed. */
  href: string;
  /** Permission needed to open `href`, so the UI can hide links a member cannot use. */
  perm: string;
};

export function readinessSteps(i: ReadinessInput): ReadinessStep[] {
  const creds = i.credentialsConfigured;
  const steps: ReadinessStep[] = [
    {
      key: "credentials",
      label: "Save the Unite credentials",
      state: creds ? "done" : "todo",
      hint: creds
        ? "Stored encrypted."
        : "Finance → Data health → Unite credentials. Use their own Unite app id and key, not Make's token.",
      href: "/finance/health",
      perm: "finance.capture.manage",
    },
    {
      key: "branches",
      label: "Map the Unite clinic names to branches",
      state: i.branchesMapped > 0 ? "done" : "todo",
      hint:
        i.branchesMapped > 0
          ? `${i.branchesMapped} branch(es) mapped.`
          : "Finance → Reference data → Branches. Without this, invoices land under “unknown branch”.",
      href: "/finance/reference",
      perm: "finance.reference.manage",
    },
    {
      key: "capture",
      label: "Switch capture on",
      state: i.captureEnabled ? "done" : creds ? "todo" : "blocked",
      hint: i.captureEnabled
        ? "Capture runs hourly."
        : creds
          ? "Start with one batch per run. Unite delivers each record once."
          : "Needs the credentials first.",
      href: "/finance/health",
      perm: "finance.capture.manage",
    },
    {
      key: "invoices",
      label: "First invoices captured",
      state: i.invoiceCount > 0 ? "done" : i.captureEnabled ? "todo" : "blocked",
      hint:
        i.invoiceCount > 0
          ? `${i.invoiceCount.toLocaleString()} invoice(s).`
          : i.captureEnabled
            ? "Arrives with the next hourly run."
            : "Needs capture switched on.",
      href: "/finance/health",
      perm: "finance.capture.manage",
    },
    {
      key: "diligence",
      label: "Import the Diligence claims report",
      state: i.claimCount > 0 && i.lastImportAt ? "done" : "todo",
      hint:
        i.claimCount > 0
          ? `${i.claimCount.toLocaleString()} claim activities loaded.`
          : "Finance → Insurance upload. Claimed, remitted, rejected and outstanding come from it.",
      href: "/finance/upload",
      perm: "finance.claims.import",
    },
    {
      key: "rules",
      label: "Exception rules active",
      state: i.activeRules > 0 ? "done" : "todo",
      hint:
        i.activeRules > 0
          ? `${i.activeRules} rule(s) active.`
          : "Finance → Reference data → Exception rules.",
      href: "/finance/reference",
      perm: "finance.reference.manage",
    },
  ];
  return steps;
}

export const isReady = (steps: readonly ReadinessStep[]) => steps.every((s) => s.state === "done");
export const doneCount = (steps: readonly ReadinessStep[]) =>
  steps.filter((s) => s.state === "done").length;

/** First thing to do next: the earliest step that is `todo`. */
export const nextStep = (steps: readonly ReadinessStep[]) =>
  steps.find((s) => s.state === "todo") ?? null;
