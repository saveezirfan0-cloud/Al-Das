"use client";

import { Input } from "@/components/ui/input";
import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";

import {
  copyPreviousTargets,
  deleteReportLine,
  saveDataQualitySettings,
  saveInsuranceRecon,
  saveFlashDisplay,
  saveMgmtAlertSettings,
  savePerfBands,
  saveRecruitDefaults,
  saveReportLine,
  saveTargets,
} from "./actions";

export type LineView = {
  code: string;
  label: string;
  matchKind: string;
  matchValues: string[];
  inCore: boolean;
  active: boolean;
  sortOrder: number;
};

export type TargetView = {
  lineCode: string | null;
  dailyRevenue: number | null;
  dailyPatients: number | null;
  arpp: number | null;
};

const Check = ({ name, label, checked }: { name: string; label: string; checked: boolean }) => (
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" name={name} defaultChecked={checked} /> {label}
  </label>
);

function LineFields({ line }: { line?: LineView }) {
  return (
    <>
      <Field label="Code" hint="Capital letters, digits or _ (for example PALM, CHIRO).">
        <Input
          name="code"
          defaultValue={line?.code ?? ""}
          readOnly={!!line}
          maxLength={12}
          required
        />
      </Field>
      <Field label="Name on the report">
        <Input name="label" defaultValue={line?.label ?? ""} maxLength={60} required />
      </Field>
      <Field label="Match invoices by">
        <select
          name="match_kind"
          defaultValue={line?.matchKind ?? "branch"}
          className={selectClass}
        >
          <option value="branch">Branch code</option>
          <option value="department">Department (wins over branch)</option>
        </select>
      </Field>
      <Field
        label="Values"
        hint="Comma-separated branch codes (P, M) or Unite department names (Chiropractic). Not case-sensitive."
      >
        <Input name="match_values" defaultValue={line?.matchValues.join(", ") ?? ""} required />
      </Field>
      <Field label="Order on the report">
        <Input name="sort_order" inputMode="numeric" defaultValue={line?.sortOrder ?? 100} />
      </Field>
      <Check
        name="in_core"
        label="Count in the main total (untick for Chiro and leased units)"
        checked={line?.inCore ?? true}
      />
      <Check name="active" label="Active" checked={line?.active ?? true} />
    </>
  );
}

export function NewLineButton() {
  return (
    <FormSheet trigger="Add line" title="Add a reporting line" variant="outline" size="sm">
      {(close) => (
        <ActionForm action={saveReportLine} submitLabel="Save line" onDone={close}>
          <LineFields />
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function EditLineButton({ line }: { line: LineView }) {
  return (
    <FormSheet trigger="Edit" title={`Edit ${line.label}`} variant="ghost" size="sm">
      {(close) => (
        <div className="flex flex-col gap-6">
          <ActionForm action={saveReportLine} submitLabel="Save line" onDone={close}>
            <LineFields line={line} />
          </ActionForm>
          <RunButton
            variant="destructive"
            confirm={`Delete the line ${line.code}? Its revenue will show as Unassigned until another line covers it.`}
            action={() => deleteReportLine({ code: line.code })}
            onDone={close}
          >
            Delete line
          </RunButton>
        </div>
      )}
    </FormSheet>
  );
}

export function TargetsForm({
  month,
  lines,
  targets,
}: {
  month: string;
  lines: { code: string; label: string; inCore: boolean }[];
  targets: TargetView[];
}) {
  const t = (code: string | null) => targets.find((x) => x.lineCode === code);
  const total = t(null);
  return (
    <ActionForm action={saveTargets} submitLabel="Save targets">
      <input type="hidden" name="month" value={month} />
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[1fr_10rem_10rem]">
        <div className="text-muted-foreground text-xs font-medium">Line</div>
        <div className="text-muted-foreground text-xs font-medium">Revenue per day (AED)</div>
        <div className="text-muted-foreground text-xs font-medium">Patients per day</div>
        {lines.map((l) => (
          <div key={l.code} className="contents">
            <div className="flex items-center text-sm">
              {l.label}
              {!l.inCore && <span className="text-muted-foreground ml-2 text-xs">(separate)</span>}
            </div>
            <Input
              name={`rev_${l.code}`}
              inputMode="decimal"
              defaultValue={t(l.code)?.dailyRevenue ?? ""}
              aria-label={`${l.label} revenue per day`}
            />
            <Input
              name={`pat_${l.code}`}
              inputMode="decimal"
              defaultValue={t(l.code)?.dailyPatients ?? ""}
              aria-label={`${l.label} patients per day`}
            />
          </div>
        ))}
        <div className="flex items-center text-sm font-semibold">Total</div>
        <Input
          name="total_rev"
          inputMode="decimal"
          defaultValue={total?.dailyRevenue ?? ""}
          placeholder="sum of the main lines"
          aria-label="Total revenue per day"
        />
        <Input
          name="total_pat"
          inputMode="decimal"
          defaultValue={total?.dailyPatients ?? ""}
          aria-label="Total patients per day"
        />
      </div>
      <Field label="ARPP target (AED per patient)" className="max-w-xs">
        <Input name="total_arpp" inputMode="decimal" defaultValue={total?.arpp ?? ""} />
      </Field>
      <p className="text-muted-foreground text-xs">
        Targets are daily rates. The month-to-date target is the daily target times the calendar
        days elapsed. Leave a box blank for no target.
      </p>
    </ActionForm>
  );
}

export function CopyTargetsButton({ month }: { month: string }) {
  return (
    <RunButton action={() => copyPreviousTargets({ month })}>
      Copy last month&apos;s targets
    </RunButton>
  );
}

export function DisplayForm({
  shareBasis,
  topDoctors,
}: {
  shareBasis: string;
  topDoctors: number;
}) {
  return (
    <ActionForm action={saveFlashDisplay} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Doctor % of total is worked out against">
          <select name="flash_share_basis" defaultValue={shareBasis} className={selectClass}>
            <option value="section">The total of that doctor table</option>
            <option value="all">The grand total (all lines)</option>
          </select>
        </Field>
        <Field label="Top doctors on the summary">
          <Input name="flash_top_doctors" inputMode="numeric" defaultValue={topDoctors} />
        </Field>
      </div>
    </ActionForm>
  );
}

/** Doctor performance (Phase 23B): the revenue-per-patient target and the lower edges of the two middle bands. */
export function PerfBandsForm({
  target,
  near,
  moderate,
}: {
  target: number;
  near: number;
  moderate: number;
}) {
  return (
    <ActionForm action={savePerfBands} submitLabel="Save target and bands">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Target, Achieved from (AED)">
          <Input name="perf_arpp_target" inputMode="decimal" defaultValue={target} required />
        </Field>
        <Field label="Near Target from (AED)">
          <Input name="perf_band_near" inputMode="decimal" defaultValue={near} required />
        </Field>
        <Field label="Moderate from (AED)">
          <Input name="perf_band_moderate" inputMode="decimal" defaultValue={moderate} required />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        Revenue per patient at or above the target is Achieved; from Near Target up to the target is
        Near Target; from Moderate up to Near Target is Moderate; below Moderate is Below Target.
        Each band starts exactly at its number, so nothing falls between bands. Expected revenue is
        patients times the target.
      </p>
    </ActionForm>
  );
}

/** Collections data quality (Phase 23D): the late invoice threshold in days. */
export function DataQualityForm({ lateInvoiceDays }: { lateInvoiceDays: number }) {
  return (
    <ActionForm action={saveDataQualitySettings} submitLabel="Save late invoice days">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Late invoice: more than this many days after the visit">
          <Input
            name="dq_late_invoice_days"
            inputMode="numeric"
            defaultValue={lateInvoiceDays}
            required
          />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        Used by Collections and data quality: an invoice raised more than this many days after the
        visit (0 to 60) is listed as a late invoice for review.
      </p>
    </ActionForm>
  );
}

export function InsuranceReconForm({
  tolerance,
  graceDays,
}: {
  tolerance: number;
  graceDays: number;
}) {
  return (
    <ActionForm action={saveInsuranceRecon} submitLabel="Save tolerance and grace days">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Difference tolerance (AED)">
          <Input name="ins_recon_tolerance" inputMode="decimal" defaultValue={tolerance} required />
        </Field>
        <Field label="Grace days before at risk">
          <Input
            name="ins_recon_grace_days"
            inputMode="numeric"
            defaultValue={graceDays}
            required
          />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        A billed invoice whose submitted amount differs by more than the tolerance, either way, is
        flagged. A billed invoice with no claim in Diligence counts as at risk once more than the
        grace days have passed since its report date.
      </p>
    </ActionForm>
  );
}

export function MgmtAlertsForm(v: {
  lateDays: number;
  targetPct: number;
  targetDays: number;
  minPatients: number;
}) {
  return (
    <ActionForm action={saveMgmtAlertSettings} submitLabel="Save alert settings">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Unite report late after (days with no covered day)">
          <Input
            name="alert_report_late_days"
            inputMode="numeric"
            defaultValue={v.lateDays}
            required
          />
        </Field>
        <Field label="Revenue behind below (% of target)">
          <Input
            name="alert_revenue_target_pct"
            inputMode="decimal"
            defaultValue={v.targetPct}
            required
          />
        </Field>
        <Field label="Revenue behind for (covered days in a row)">
          <Input
            name="alert_revenue_target_days"
            inputMode="numeric"
            defaultValue={v.targetDays}
            required
          />
        </Field>
        <Field label="Band alert: minimum patients per doctor">
          <Input
            name="alert_band_min_patients"
            inputMode="numeric"
            defaultValue={v.minPatients}
            required
          />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        Checked every morning. The report alert goes to the people who upload the Unite report when
        no committed upload covers any of the last days set here. The revenue alert goes to flash
        report readers when month-to-date revenue (the total, and each branch line with a target)
        stays below this share of its target on each of the last covered days set here; the target
        counts only the days the report covers, not calendar days. Once last month is fully covered,
        one alert says how many doctors with at least the minimum patients were Below Target. Each
        alert is sent once until it clears; notifications never name a doctor or an amount.
      </p>
    </ActionForm>
  );
}

export function RecruitDefaultsForm(v: {
  conservative: number;
  consumables: number;
  gateway: number;
  minPeerMonths: number;
}) {
  return (
    <ActionForm action={saveRecruitDefaults} submitLabel="Save recruitment defaults">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Conservative factor on claimed revenue (%)">
          <Input
            name="recruit_conservative_pct"
            inputMode="decimal"
            defaultValue={v.conservative}
            required
          />
        </Field>
        <Field label="Consumables (% of revenue)">
          <Input
            name="recruit_consumables_pct"
            inputMode="decimal"
            defaultValue={v.consumables}
            required
          />
        </Field>
        <Field label="Payment gateway (% of revenue)">
          <Input name="recruit_gateway_pct" inputMode="decimal" defaultValue={v.gateway} required />
        </Field>
        <Field label="Doctor-months for a department benchmark">
          <Input
            name="recruit_min_peer_months"
            inputMode="numeric"
            defaultValue={v.minPeerMonths}
            required
          />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        The recruitment calculator starts every scenario with these (each scenario can change them).
        A department is compared with its own doctors only when the Unite report holds at least this
        many doctor-months from two or more doctors; otherwise the clinic-wide figures are used.
      </p>
    </ActionForm>
  );
}
