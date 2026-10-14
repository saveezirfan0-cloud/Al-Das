/**
 * Step 7: Sanoflow campaign reports → the read-only campaign archive (campaign_archive and
 * campaign_archive_recipients). Past campaigns never become rows of `campaigns`: those need a Pulse
 * template and channel, and the send engine acts on them. Nothing is ever sent from the archive.
 *
 * One report file per campaign is usual ("campaign-report-<name>.csv"); a combined export with a
 * campaign column works too. Totals come from every row of the report (also people who are not in
 * Pulse), so they match Sanoflow; only patients found in Pulse get a recipient row. Several rows
 * for one patient (retry rounds) collapse to the furthest status reached. Only statuses, times and
 * an error code are kept: no phone number, no message text.
 */
import type { ParsedCsv } from "@/lib/csv";
import { normalizePhone } from "@/lib/phone";

import { cell, mapHeaders } from "./mapping";
import { newRun, problem, resolveContact, warn, type EntityRun, type RunContext } from "./run";
import {
  mapRecipientStatus,
  nameKey,
  parseLocalDateTime,
  statusRank,
  type ArchiveStatus,
} from "./values";

type Row = {
  line: number;
  contactRaw: string;
  phoneRaw: string;
  status: ArchiveStatus;
  times: Record<"sent_at" | "delivered_at" | "read_at" | "replied_at" | "failed_at", string | null>;
  errorCode: number | null;
};

type Campaign = { key: string; name: string; template: string | null; rows: Map<string, Row> };

const TIME_FIELDS = ["sent_at", "delivered_at", "read_at", "replied_at", "failed_at"] as const;

/** "campaign-report-Ramadan offer.csv" → "Ramadan offer". */
export function campaignNameFromFile(file: string): string {
  return file
    .replace(/\.csv$/i, "")
    .replace(/^campaigns?[-_ ]+(report|history|recipients)?[-_ ]*/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

export async function runCampaignHistory(
  ctx: RunContext,
  files: Array<{ file: string; csv: ParsedCsv }>,
  override?: Record<string, string | null>,
): Promise<{ campaigns: EntityRun; recipients: EntityRun }> {
  const label = files.map((f) => f.file).join(", ") || null;
  const campaigns = newRun("campaign", "Campaign history", label);
  const recipients = newRun("campaign_recipient", "Campaign history recipients", label);
  const byKey = new Map<string, Campaign>();
  let line = 0;

  // 1. Read every file and collapse rows per campaign and patient.
  for (const { file, csv } of files) {
    const h = mapHeaders("campaign_recipient", csv.headers, { override });
    for (const u of h.unknown)
      if (!recipients.unknownHeaders.includes(u)) recipients.unknownHeaders.push(u);
    if (h.missing.length) {
      recipients.fatal = `${file}: missing column ${h.missing.join(", ")}`;
      return { campaigns, recipients };
    }
    const fromFile = campaignNameFromFile(file);
    const get = (row: string[], f: string) => cell(row, h.index, f);
    for (const row of csv.rows) {
      line++;
      recipients.counters.read++;
      const name = (get(row, "campaign") || fromFile).slice(0, 200);
      const key = get(row, "campaign_id") || nameKey(name);
      const contactRaw = get(row, "contact_id");
      const phoneRaw = get(row, "phone");
      const who = contactRaw || normalizePhone(phoneRaw)?.e164 || "";
      if (!key || !name || !who) {
        recipients.counters.invalid++;
        problem(recipients, line, !key || !name ? "no_campaign" : "no_contact_key");
        continue;
      }
      let c = byKey.get(key);
      if (!c)
        byKey.set(
          key,
          (c = {
            key,
            name,
            template: get(row, "template").slice(0, 200) || null,
            rows: new Map(),
          }),
        );
      const times = Object.fromEntries(
        TIME_FIELDS.map((f) => {
          const raw = get(row, f);
          const d = raw ? parseLocalDateTime(raw, null, ctx.timezone, ctx.config.date_order) : null;
          if (raw && !d) warn(recipients, `${f}_unreadable`);
          return [f, d ? d.toISOString() : null];
        }),
      ) as Row["times"];
      const code = Number.parseInt(get(row, "error_code"), 10);
      const next: Row = {
        line,
        contactRaw,
        phoneRaw,
        status: mapRecipientStatus(get(row, "status")),
        times,
        errorCode: Number.isFinite(code) ? code : null,
      };
      const prev = c.rows.get(who);
      if (prev) {
        recipients.counters.duplicates++;
        // keep the furthest status, and every time either row knew
        const best = statusRank(next.status) > statusRank(prev.status) ? next : prev;
        const other = best === next ? prev : next;
        for (const f of TIME_FIELDS) best.times[f] ??= other.times[f];
        c.rows.set(who, best);
      } else c.rows.set(who, next);
    }
  }

  // 2. Write each campaign, then its recipients.
  for (const c of byKey.values()) {
    campaigns.counters.read++;
    const tally: Record<string, number> = { recipients: c.rows.size };
    let sentAt: string | null = null;
    for (const r of c.rows.values()) {
      tally[r.status] = (tally[r.status] ?? 0) + 1;
      const t = r.times.sent_at;
      if (t && (!sentAt || t < sentAt)) sentAt = t;
    }
    const values = { name: c.name, template_name: c.template, sent_at: sentAt, totals: tally };
    let archiveId: string | null = null;
    const ref = await ctx.ports.findRef("campaign", c.key);
    const current = ref ? await ctx.ports.getRow("campaign_archive", ref.localId) : null;
    if (current) {
      archiveId = current.id;
      const same =
        current.name === values.name &&
        JSON.stringify(current.totals ?? {}) === JSON.stringify(values.totals) &&
        Date.parse(String(current.sent_at ?? "")) === Date.parse(String(values.sent_at ?? ""));
      if (same || ctx.mode === "skip") campaigns.counters.unchanged++;
      else {
        const res = await ctx.ports.updateRow("campaign_archive", archiveId, values);
        if (res.error) campaigns.counters.failed++;
        else campaigns.counters.updated++;
      }
    } else {
      const res = await ctx.ports.insertRow("campaign_archive", { source: "sanoflow", ...values });
      if ("error" in res) {
        campaigns.counters.failed++;
        for (const r of c.rows.values()) {
          recipients.counters.failed++;
          problem(recipients, r.line, "campaign_not_created");
        }
        continue;
      }
      archiveId = res.id;
      campaigns.counters.created++;
      await ctx.ports.upsertRef({
        entity: "campaign",
        externalId: c.key,
        localTable: "campaign_archive",
        localId: archiveId,
      });
    }

    for (const [who, r] of c.rows) {
      const ext = `${c.key}|${who}`;
      const contact = await resolveContact(ctx.ports, r.contactRaw, r.phoneRaw);
      if (contact.kind !== "match") {
        recipients.counters.invalid++;
        problem(
          recipients,
          r.line,
          contact.kind === "none" ? "contact_not_found" : "contact_ambiguous",
        );
        continue;
      }
      const row = {
        archive_id: archiveId,
        contact_id: contact.id,
        status: r.status,
        ...r.times,
        error_code: r.errorCode,
      };
      const refRow = await ctx.ports.findRef("campaign_recipient", ext);
      const existing =
        (refRow ? await ctx.ports.getRow("campaign_archive_recipients", refRow.localId) : null) ??
        (await ctx.ports.findOne("campaign_archive_recipients", {
          archive_id: archiveId,
          contact_id: contact.id,
        }));
      if (existing) {
        const better = statusRank(r.status) > statusRank(existing.status as ArchiveStatus);
        if (better && ctx.mode !== "skip") {
          const res = await ctx.ports.updateRow("campaign_archive_recipients", existing.id, row);
          if (res.error) {
            recipients.counters.failed++;
            problem(recipients, r.line, res.error);
            continue;
          }
          recipients.counters.updated++;
        } else if (refRow) recipients.counters.unchanged++;
        else recipients.counters.adopted++;
        if (!refRow)
          await ctx.ports.upsertRef({
            entity: "campaign_recipient",
            externalId: ext,
            localTable: "campaign_archive_recipients",
            localId: existing.id,
          });
        continue;
      }
      const res = await ctx.ports.insertRow("campaign_archive_recipients", row);
      if ("error" in res) {
        recipients.counters.failed++;
        problem(recipients, r.line, res.error);
        continue;
      }
      recipients.counters.created++;
      await ctx.ports.upsertRef({
        entity: "campaign_recipient",
        externalId: ext,
        localTable: "campaign_archive_recipients",
        localId: res.id,
      });
    }
  }
  return { campaigns, recipients };
}
