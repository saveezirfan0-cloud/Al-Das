/**
 * `pnpm import:sanoflow:all`: every Sanoflow export in one folder, in dependency order:
 *
 *   1 config      sanoflow-config.json            pipelines, stages, enquiry fields, sources
 *   2 lists       tags / labels / categories / quick-replies *.csv
 *   3 contacts    contacts*.csv                   (refs the later steps link through)
 *   4 segments    segment-*.csv, segments-static*.csv; segments-dynamic*.csv is report-only
 *   5 enquiries   enquiries*.csv                  (one per pipeline and/or "all")
 *   6 activity    enquiry-activity*.csv
 *   7 campaigns   campaign-report-<name>.csv      read-only campaign history (campaign_archive)
 *   8 appointments appointments*.csv              future only; real writes need --with-appointments
 *
 * A file "<step>.map.json" next to the exports overrides that step's header mapping
 * ({ "CSV header": "field" | null }); sanoflow-names.json maps location / specialist / service names.
 */
import fs from "node:fs";
import path from "node:path";

import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { parseCsv, type ParsedCsv } from "@/lib/csv";
import { normalizePhone } from "@/lib/phone";
import type { AdminClient } from "@/lib/supabase/admin";

import { loadCustomFieldsForScript } from "../custom-fields";
import { EMPTY_NAMES, loadConfig, loadNames, type SanoflowConfig } from "./config";
import { runSanoflowContacts } from "./contacts";
import { cell, mapHeaders, type SanoflowExport } from "./mapping";
import { DryRunPorts, supabaseSlotBusy, SupabasePorts, type SanoflowPorts } from "./ports";
import type { EntityRun, RunContext } from "./run";
import { runActivity } from "./run-activity";
import { runAppointments } from "./run-appointments";
import { campaignNameFromFile, runCampaignHistory } from "./run-campaigns";
import { runConfig } from "./run-config";
import { runEnquiries } from "./run-enquiries";
import { runList, runQuickReplies } from "./run-lists";
import { readDynamicSegments, runStaticSegments, type DynamicSegment } from "./run-segments";
import { nameKey, stableId } from "./values";

export const STEP_FILES = {
  tag: /^tags?([-_ ].*)?\.csv$/i,
  label: /^labels?([-_ ].*)?\.csv$/i,
  conv_category: /^(conversation[-_ ])?categor(y|ies)([-_ ].*)?\.csv$/i,
  quick_reply: /^(quick[-_ ]?replies|canned[-_ ]messages)([-_ ].*)?\.csv$/i,
  contact: /^contacts?([-_ ].*)?\.csv$/i,
  segment_member: /^(segment[-_ ](?!dynamic).+|segments[-_ ]static([-_ ].*)?)\.csv$/i,
  segment_dynamic: /^segments?[-_ ]dynamic([-_ ].*)?\.csv$/i,
  enquiry: /^enquir(y|ies)(?![-_ ]activit)([-_ ].*)?\.csv$/i,
  enquiry_activity: /^(enquir(y|ies)[-_ ])?activit(y|ies)([-_ ].*)?\.csv$/i,
  appointment: /^appointments?([-_ ].*)?\.csv$/i,
  campaign_recipient: /^campaigns?[-_ ](report|history|recipients)([-_ ].*)?\.csv$/i,
} as const;
export type StepKey = keyof typeof STEP_FILES;

/** Which step each file in the folder belongs to; unrecognised files are returned separately. */
export function classifyFiles(names: string[]): {
  byStep: Record<StepKey, string[]>;
  unknown: string[];
} {
  const byStep = Object.fromEntries(
    Object.keys(STEP_FILES).map((k) => [k, [] as string[]]),
  ) as Record<StepKey, string[]>;
  const unknown: string[] = [];
  for (const n of [...names].sort()) {
    if (!n.toLowerCase().endsWith(".csv")) continue;
    const step = (Object.keys(STEP_FILES) as StepKey[]).find((k) => STEP_FILES[k].test(n));
    if (step) byStep[step].push(n);
    else unknown.push(n);
  }
  return { byStep, unknown };
}

type Loaded = { file: string; csv: ParsedCsv };

function readCsvs(dir: string, files: string[]): Loaded[] {
  return files.map((file) => ({
    file,
    csv: parseCsv(fs.readFileSync(path.join(dir, file), "utf8")),
  }));
}

function readOverride(dir: string, step: string): Record<string, string | null> | undefined {
  const f = path.join(dir, `${step}.map.json`);
  return fs.existsSync(f)
    ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, string | null>)
    : undefined;
}

/**
 * Records per reconciled entity in the export folder, the way the importers key them: distinct ids
 * (the same enquiry appears in a per-pipeline and the all-pipelines export), rows otherwise.
 * Written next to the report so `pnpm reconcile --sanoflow-counts` can check every record landed.
 */
export function sourceCounts(
  dir: string,
  byStep: Record<StepKey, string[]>,
): Record<string, number> {
  const distinct = (
    kind: SanoflowExport,
    files: string[],
    key: (row: string[], idx: Record<string, number>) => string,
  ) => {
    const seen = new Set<string>();
    let blank = 0;
    for (const { csv } of readCsvs(dir, files)) {
      const h = mapHeaders(kind, csv.headers, { override: readOverride(dir, kind) });
      for (const row of csv.rows) {
        const k = key(row, h.index);
        if (k) seen.add(k);
        else blank++;
      }
    }
    return seen.size + blank;
  };
  const rows = (files: string[]) => readCsvs(dir, files).reduce((n, f) => n + f.csv.rows.length, 0);
  return {
    contact: rows(byStep.contact),
    enquiry: distinct("enquiry", byStep.enquiry, (r, i) => cell(r, i, "id")),
    enquiry_activity: distinct(
      "enquiry_activity",
      byStep.enquiry_activity,
      (r, i) =>
        cell(r, i, "id") ||
        stableId([
          cell(r, i, "enquiry_id"),
          cell(r, i, "at"),
          cell(r, i, "kind"),
          cell(r, i, "text"),
        ]),
    ),
    appointment: distinct("appointment", byStep.appointment, (r, i) => cell(r, i, "id")),
    segment_member: rows(byStep.segment_member),
    campaign_recipient: (() => {
      const seen = new Set<string>();
      let blank = 0;
      for (const { file, csv } of readCsvs(dir, byStep.campaign_recipient)) {
        const h = mapHeaders("campaign_recipient", csv.headers, {
          override: readOverride(dir, "campaign_recipient"),
        });
        const fromFile = campaignNameFromFile(file);
        for (const r of csv.rows) {
          const camp =
            cell(r, h.index, "campaign_id") || nameKey(cell(r, h.index, "campaign") || fromFile);
          const who =
            cell(r, h.index, "contact_id") || normalizePhone(cell(r, h.index, "phone"))?.e164 || "";
          if (camp && who) seen.add(`${camp}|${who}`);
          else blank++;
        }
      }
      return seen.size + blank;
    })(),
  };
}

export type AllOptions = {
  dir: string;
  dryRun: boolean;
  mode: "update" | "skip";
  /** Really book appointments (cut-over day). Without it the appointment step is a dry run. */
  withAppointments: boolean;
  /** Steps to run (default all). */
  only?: Set<string>;
  now?: Date;
  log?: (msg: string) => void;
};

export type AllResult = {
  runs: EntityRun[];
  dynamicSegments: DynamicSegment[];
  notes: string[];
  counts: Record<string, number>;
  unknownFiles: string[];
};

export async function runAll(
  admin: AdminClient,
  org: { id: string; slug: string; timezone: string },
  opts: AllOptions,
  /** Tests inject ports; real runs use Supabase (wrapped for dry runs). */
  portsOverride?: { real: SanoflowPorts; dry: SanoflowPorts },
): Promise<AllResult> {
  const log = opts.log ?? (() => {});
  const dir = opts.dir;
  if (!fs.existsSync(dir)) throw new Error(`export folder not found: ${dir}`);
  const { byStep, unknown } = classifyFiles(fs.readdirSync(dir));
  const configFile = path.join(dir, "sanoflow-config.json");
  if (!fs.existsSync(configFile))
    throw new Error(
      `${configFile} is missing (start from docs/audit/sanoflow-config.example.json)`,
    );
  const config: SanoflowConfig = loadConfig(configFile);
  const namesFile = path.join(dir, "sanoflow-names.json");
  const names = fs.existsSync(namesFile) ? loadNames(namesFile) : EMPTY_NAMES;

  const realPorts = portsOverride?.real ?? new SupabasePorts(admin, org.id);
  const dryPorts =
    portsOverride?.dry ?? new DryRunPorts(realPorts, supabaseSlotBusy(admin, org.id));
  const ports = opts.dryRun ? dryPorts : realPorts;
  const ctx: RunContext = {
    ports,
    config,
    names,
    timezone: org.timezone || "Asia/Dubai",
    now: opts.now ?? new Date(),
    mode: opts.mode,
  };
  const want = (s: string) => !opts.only || opts.only.has(s);
  const runs: EntityRun[] = [];
  const notes: string[] = [];
  let dynamicSegments: DynamicSegment[] = [];
  if (unknown.length)
    notes.push(`Files not recognised and not read: ${unknown.map((u) => `\`${u}\``).join(", ")}`);
  if (opts.dryRun)
    notes.push(
      "Dry run: contacts this run would create are not visible to the later steps, so their contact_not_found counts are upper bounds.",
    );

  if (want("config")) {
    log("1/8 config");
    runs.push(...(await runConfig(ctx)));
  }
  if (want("lists")) {
    log("2/8 tags, labels, categories, quick replies");
    for (const kind of ["tag", "label", "conv_category"] as const)
      for (const { file, csv } of readCsvs(dir, byStep[kind]))
        runs.push(await runList(ctx, kind, csv, file, readOverride(dir, kind)));
    for (const { file, csv } of readCsvs(dir, byStep.quick_reply))
      runs.push(await runQuickReplies(ctx, csv, file, readOverride(dir, "quick_reply")));
  }
  if (want("contacts")) {
    log("3/8 contacts");
    const customFields: CustomFieldDef[] = await loadCustomFieldsForScript(admin, org.id);
    for (const { file, csv } of readCsvs(dir, byStep.contact)) {
      const res = await runSanoflowContacts(admin, org.id, csv, {
        file,
        dryRun: opts.dryRun,
        mode: opts.mode,
        customFields,
        map: readOverride(dir, "contact"),
        onProgress: (n) => log(`  … ${n} contacts written`),
      });
      runs.push(res.run);
    }
  }
  if (want("segments")) {
    log("4/8 segments");
    if (byStep.segment_member.length) {
      const { segments, members } = await runStaticSegments(
        ctx,
        readCsvs(dir, byStep.segment_member),
        readOverride(dir, "segment_member"),
      );
      runs.push(segments, members);
    }
    for (const { file, csv } of readCsvs(dir, byStep.segment_dynamic)) {
      const { run, segments } = readDynamicSegments(
        csv,
        file,
        readOverride(dir, "segment_dynamic"),
      );
      runs.push(run);
      dynamicSegments = dynamicSegments.concat(segments);
    }
  }
  if (want("enquiries")) {
    log("5/8 enquiries");
    if (byStep.enquiry.length)
      runs.push(
        await runEnquiries(ctx, readCsvs(dir, byStep.enquiry), readOverride(dir, "enquiry")),
      );
  }
  if (want("activity")) {
    log("6/8 enquiry activity");
    if (byStep.enquiry_activity.length)
      runs.push(
        await runActivity(
          ctx,
          readCsvs(dir, byStep.enquiry_activity),
          readOverride(dir, "enquiry_activity"),
        ),
      );
  }
  if (want("campaigns") && byStep.campaign_recipient.length) {
    log("7/8 campaign history");
    const { campaigns, recipients } = await runCampaignHistory(
      ctx,
      readCsvs(dir, byStep.campaign_recipient),
      readOverride(dir, "campaign_recipient"),
    );
    runs.push(campaigns, recipients);
  }
  if (want("appointments") && byStep.appointment.length) {
    log("8/8 future appointments");
    const live = !opts.dryRun && opts.withAppointments;
    if (!opts.dryRun && !opts.withAppointments)
      notes.push(
        "Appointments ran as a DRY RUN: pass --with-appointments on cut-over day, after Sanoflow's reminders are off " +
          "(imported bookings get Pulse reminders from the next sweep).",
      );
    const run = await runAppointments(
      { ...ctx, ports: live ? realPorts : dryPorts },
      readCsvs(dir, byStep.appointment),
      readOverride(dir, "appointment"),
    );
    if (!live) {
      run.label = `${run.label} (dry run)`;
      run.dryRun = true;
    }
    runs.push(run);
  }
  for (const r of runs) if (r.fatal) log(`  ! ${r.label}: ${r.fatal}`);
  return { runs, dynamicSegments, notes, counts: sourceCounts(dir, byStep), unknownFiles: unknown };
}
