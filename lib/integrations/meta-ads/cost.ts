/**
 * Ad performance for the Ad attribution report (pure): joins Pulse's own counts per ad (conversations, patients, enquiries and
 * bookings from ad_attribution_report, keyed by the ad id the click-to-WhatsApp referral carried) with Meta's spend, impressions and
 * clicks per ad (ad_spend_report), and works out the cost per conversation, per enquiry and per booking. Counts and amounts only.
 *
 * Money stays an integer number of thousandths of the ad account's currency until it is shown. An ad whose spend arrived in more
 * than one currency (the account currency changed) gets no spend and no cost figures rather than a sum of unlike amounts.
 */

export type AttributionCounts = {
  source_id: string;
  source_type: string;
  headline: string | null;
  conversations: number;
  patients: number;
  enquiries: number;
  appointments: number;
};

export type SpendTotals = {
  ad_id: string;
  currency: string;
  ad_name: string | null;
  campaign_name: string | null;
  spend_milli: number;
  impressions: number;
  clicks: number;
  days: number;
  pulled_at: string | null;
};

export type AdPerformanceRow = {
  key: string;
  /** Meta's ad id, or null for a referral that was not an ad (a boosted post) or carried no id. */
  adId: string | null;
  sourceType: string;
  sourceId: string;
  label: string;
  campaignName: string | null;
  conversations: number;
  patients: number;
  enquiries: number;
  appointments: number;
  /** Null when Pulse has no spend for this ad, or when it came in more than one currency (see mixedCurrency). */
  spendMilli: number | null;
  currency: string | null;
  mixedCurrency: boolean;
  impressions: number | null;
  clicks: number | null;
  costPerConversationMilli: number | null;
  costPerEnquiryMilli: number | null;
  costPerBookingMilli: number | null;
};

export type CurrencyTotals = {
  currency: string;
  spendMilli: number;
  impressions: number;
  clicks: number;
  /** Counts for the ads that have spend in this currency (so the cost figures divide like by like). */
  conversations: number;
  enquiries: number;
  appointments: number;
  costPerConversationMilli: number | null;
  costPerEnquiryMilli: number | null;
  costPerBookingMilli: number | null;
};

/** Spend divided by a count, rounded to the nearest thousandth; null when there is nothing to divide by. */
export function costPerMilli(spendMilli: number, count: number): number | null {
  if (!Number.isFinite(spendMilli) || spendMilli < 0) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  return Math.round(spendMilli / count);
}

/** A referral's source id is an ad id only when its type is "ad" and it is Meta's numeric id. */
export function adIdOf(sourceType: string, sourceId: string): string | null {
  return sourceType === "ad" && /^\d{1,30}$/.test(sourceId) ? sourceId : null;
}

type SpendByAd = {
  currency: string | null;
  mixed: boolean;
  spendMilli: number;
  impressions: number;
  clicks: number;
  adName: string | null;
  campaignName: string | null;
};

function foldSpend(spend: readonly SpendTotals[]): Map<string, SpendByAd> {
  const byAd = new Map<string, SpendByAd>();
  for (const s of spend) {
    const cur = byAd.get(s.ad_id);
    if (!cur) {
      byAd.set(s.ad_id, {
        currency: s.currency,
        mixed: false,
        spendMilli: s.spend_milli,
        impressions: s.impressions,
        clicks: s.clicks,
        adName: s.ad_name,
        campaignName: s.campaign_name,
      });
      continue;
    }
    if (cur.currency !== s.currency) cur.mixed = true;
    cur.spendMilli += s.spend_milli;
    cur.impressions += s.impressions;
    cur.clicks += s.clicks;
    cur.adName ??= s.ad_name;
    cur.campaignName ??= s.campaign_name;
  }
  return byAd;
}

export function mergeAdPerformance(
  attribution: readonly AttributionCounts[],
  spend: readonly SpendTotals[],
): AdPerformanceRow[] {
  const byAd = foldSpend(spend);
  const used = new Set<string>();
  const rows: AdPerformanceRow[] = [];

  const build = (
    key: string,
    adId: string | null,
    sourceType: string,
    sourceId: string,
    counts: Pick<
      AttributionCounts,
      "headline" | "conversations" | "patients" | "enquiries" | "appointments"
    >,
    s: SpendByAd | undefined,
  ): AdPerformanceRow => {
    const usable = s && !s.mixed ? s : undefined;
    const spendMilli = usable ? usable.spendMilli : null;
    return {
      key,
      adId,
      sourceType,
      sourceId,
      label: counts.headline ?? s?.adName ?? "(no headline)",
      campaignName: s?.campaignName ?? null,
      conversations: counts.conversations,
      patients: counts.patients,
      enquiries: counts.enquiries,
      appointments: counts.appointments,
      spendMilli,
      currency: usable ? usable.currency : null,
      mixedCurrency: s?.mixed === true,
      impressions: s ? s.impressions : null,
      clicks: s ? s.clicks : null,
      costPerConversationMilli:
        spendMilli === null ? null : costPerMilli(spendMilli, counts.conversations),
      costPerEnquiryMilli: spendMilli === null ? null : costPerMilli(spendMilli, counts.enquiries),
      costPerBookingMilli:
        spendMilli === null ? null : costPerMilli(spendMilli, counts.appointments),
    };
  };

  for (const a of attribution) {
    const adId = adIdOf(a.source_type, a.source_id);
    const s = adId ? byAd.get(adId) : undefined;
    if (adId && s) used.add(adId);
    rows.push(build(`${a.source_type}:${a.source_id}`, adId, a.source_type, a.source_id, a, s));
  }
  // Ads Meta charged for that brought no conversation in the period still belong in the report.
  for (const [adId, s] of byAd) {
    if (used.has(adId)) continue;
    rows.push(
      build(
        `ad:${adId}`,
        adId,
        "ad",
        adId,
        { headline: null, conversations: 0, patients: 0, enquiries: 0, appointments: 0 },
        s,
      ),
    );
  }
  return rows.sort(
    (x, y) =>
      (y.spendMilli ?? -1) - (x.spendMilli ?? -1) ||
      y.conversations - x.conversations ||
      x.key.localeCompare(y.key),
  );
}

/** Totals per currency over the ads that have spend in it. */
export function totalsByCurrency(rows: readonly AdPerformanceRow[]): CurrencyTotals[] {
  const out = new Map<string, Omit<CurrencyTotals, `costPer${string}`>>();
  for (const r of rows) {
    if (r.spendMilli === null || !r.currency) continue;
    const t = out.get(r.currency) ?? {
      currency: r.currency,
      spendMilli: 0,
      impressions: 0,
      clicks: 0,
      conversations: 0,
      enquiries: 0,
      appointments: 0,
    };
    t.spendMilli += r.spendMilli;
    t.impressions += r.impressions ?? 0;
    t.clicks += r.clicks ?? 0;
    t.conversations += r.conversations;
    t.enquiries += r.enquiries;
    t.appointments += r.appointments;
    out.set(r.currency, t);
  }
  return [...out.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((t) => ({
      ...t,
      costPerConversationMilli: costPerMilli(t.spendMilli, t.conversations),
      costPerEnquiryMilli: costPerMilli(t.spendMilli, t.enquiries),
      costPerBookingMilli: costPerMilli(t.spendMilli, t.appointments),
    }));
}

/** Shows an amount in thousandths as money ("AED 1,234.50"); "n/a" for null. */
export function formatMilli(milli: number | null, currency: string | null): string {
  if (milli === null || !currency) return "n/a";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(milli / 1000);
  } catch {
    return `${currency} ${(milli / 1000).toFixed(2)}`;
  }
}
