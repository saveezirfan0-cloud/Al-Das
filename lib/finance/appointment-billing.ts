/**
 * Unite appointments <-> Unite invoices, and doctor / room utilisation for a month (W2,
 * docs/47_W2_APPOINTMENTS_INVOICES_NOTES.md). Pure: the server loader gathers the inputs. No threshold is needed, so
 * nothing here reads settings.
 *
 * THE STATUS RULE (Unite's four appointment statuses):
 *   Honoured                    the patient was seen: an invoice is expected.
 *   Cancelled                   not seen: no invoice is expected, so a cancelled appointment with no invoice is NOT
 *                               "seen, not billed".
 *   Confirmed / Awaiting        not yet closed: no invoice is not an exception (counted as "still open").
 *   Confirmation
 *
 * MATCHING (never guessed):
 *   1. By appointment id: an invoice whose appointment id equals the appointment's.
 *   2. Only for an appointment that step 1 left without an invoice: an invoice with NO appointment id (a direct
 *      invoice) for the same Unite PIN, the same doctor and the same day. It is used only when exactly one
 *      appointment that is not cancelled has that PIN, doctor and day; with two or more it is listed for review.
 *   An appointment id that appears twice in the file is listed for review, not matched.
 *
 * VERDICT per appointment:
 *   seen_billed      honoured, with an invoice
 *   seen_not_billed  honoured, no invoice, and the day is inside the dates the invoices cover
 *   billed_not_seen  has an invoice but is not honoured (cancelled, or still confirmed / awaiting)
 *   cancelled        cancelled, no invoice (nothing to do)
 *   open             confirmed / awaiting, no invoice (nothing to do yet)
 *   not_judged       honoured, no invoice, but the day is outside the dates the invoices cover (billing cannot be
 *                    judged: the invoice feed has no data for that day)
 *   review           duplicate appointment id, or an ambiguous PIN + doctor + day
 * An invoice with no appointment id is valid (a direct invoice) and is never "billed, not seen". An invoice whose
 * appointment id is not in the file is listed for review ("invoice's appointment not in the file").
 */

export type ApptStatus = "awaiting" | "confirmed" | "honoured" | "cancelled";

export type ApptIn = {
  /** The row's own id (fin_appt_rows.id). */
  id: string;
  appointmentId: string;
  /** yyyy-mm-dd */
  date: string;
  status: ApptStatus;
  pin: string | null;
  doctorKey: string;
  doctorName: string;
  /** Finance branch code; null = the clinic is not mapped. */
  branch: string | null;
  room: string | null;
  /** Booked minutes; null = the file did not say. */
  minutes: number | null;
};

export type InvoiceIn = {
  id: string;
  invoiceNo: string;
  /** null or blank = a direct invoice */
  appointmentId: string | null;
  pin: string | null;
  doctorKey: string;
  /** yyyy-mm-dd */
  date: string;
  branch: string | null;
};

export type Verdict =
  | "seen_billed"
  | "seen_not_billed"
  | "billed_not_seen"
  | "cancelled"
  | "open"
  | "not_judged"
  | "review";
export type ReviewReason = "duplicate_appointment_id" | "ambiguous_pin_doctor_day";
export type MatchBasis = "appointment_id" | "pin_doctor_day";

export type ApptResult = ApptIn & {
  verdict: Verdict;
  basis: MatchBasis | null;
  invoiceNos: string[];
  reason: ReviewReason | null;
};

export type MatchResult = {
  appointments: ApptResult[];
  /** Invoices that name an appointment id the file does not hold (and are not part of a duplicate-id review). */
  invoicesNotInFile: InvoiceIn[];
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  seen_billed: "Seen and billed",
  seen_not_billed: "Seen, not billed",
  billed_not_seen: "Billed, not seen",
  cancelled: "Cancelled, no invoice",
  open: "Still open (confirmed or awaiting)",
  not_judged: "Seen, no invoice data for that day",
  review: "Needs review",
};

export const REASON_LABEL: Record<ReviewReason, string> = {
  duplicate_appointment_id: "The appointment id appears more than once in the file",
  ambiguous_pin_doctor_day:
    "Several appointments share this PIN, doctor and day, so the invoice cannot be tied to one",
};

export const STATUS_LABEL: Record<ApptStatus, string> = {
  awaiting: "Awaiting confirmation",
  confirmed: "Confirmed",
  honoured: "Honoured",
  cancelled: "Cancelled",
};

const trim = (s: string | null | undefined) => (s ?? "").trim();
const NO_DOCTOR = "(no doctor)";

export type BillingWindow = { from: string; to: string } | null;

/**
 * @param window the first and last day the invoice data covers for the month (null = no invoices at all, so nothing is
 *   judged as not billed).
 */
export function matchAppointments(
  appts: readonly ApptIn[],
  invoices: readonly InvoiceIn[],
  window: BillingWindow,
): MatchResult {
  const idCount = new Map<string, number>();
  for (const a of appts)
    idCount.set(trim(a.appointmentId), (idCount.get(trim(a.appointmentId)) ?? 0) + 1);
  const duplicate = (a: ApptIn) => (idCount.get(trim(a.appointmentId)) ?? 0) > 1;

  const byApptId = new Map<string, InvoiceIn[]>();
  const direct: InvoiceIn[] = [];
  for (const inv of invoices) {
    const key = trim(inv.appointmentId);
    if (key === "") direct.push(inv);
    else byApptId.set(key, [...(byApptId.get(key) ?? []), inv]);
  }

  // direct invoices by PIN | doctor | day
  const pdd = (pin: string | null, doctorKey: string, date: string) =>
    `${trim(pin)}|${doctorKey}|${date}`;
  const directBy = new Map<string, InvoiceIn[]>();
  for (const inv of direct) {
    if (trim(inv.pin) === "" || inv.doctorKey === "" || inv.doctorKey === NO_DOCTOR) continue;
    const k = pdd(inv.pin, inv.doctorKey, inv.date);
    directBy.set(k, [...(directBy.get(k) ?? []), inv]);
  }
  // how many appointments that are not cancelled (and have a unique id) share each PIN | doctor | day
  const live = new Map<string, number>();
  for (const a of appts) {
    if (a.status === "cancelled" || duplicate(a) || trim(a.pin) === "") continue;
    const k = pdd(a.pin, a.doctorKey, a.date);
    live.set(k, (live.get(k) ?? 0) + 1);
  }

  const seenIds = new Set(appts.map((a) => trim(a.appointmentId)));
  const results: ApptResult[] = appts.map((a) => {
    const base = {
      ...a,
      basis: null as MatchBasis | null,
      invoiceNos: [] as string[],
      reason: null as ReviewReason | null,
    };
    if (duplicate(a)) return { ...base, verdict: "review", reason: "duplicate_appointment_id" };

    let matched = byApptId.get(trim(a.appointmentId)) ?? [];
    let basis: MatchBasis | null = matched.length > 0 ? "appointment_id" : null;
    if (matched.length === 0 && a.status !== "cancelled" && trim(a.pin) !== "") {
      const k = pdd(a.pin, a.doctorKey, a.date);
      const candidates = directBy.get(k) ?? [];
      if (candidates.length > 0) {
        if ((live.get(k) ?? 0) > 1)
          return { ...base, verdict: "review", reason: "ambiguous_pin_doctor_day" };
        matched = candidates;
        basis = "pin_doctor_day";
      }
    }
    const invoiceNos = matched.map((m) => m.invoiceNo).sort();
    if (matched.length > 0)
      return {
        ...base,
        basis,
        invoiceNos,
        verdict: a.status === "honoured" ? "seen_billed" : "billed_not_seen",
      };
    if (a.status === "cancelled") return { ...base, verdict: "cancelled" };
    if (a.status !== "honoured") return { ...base, verdict: "open" };
    const covered = window !== null && a.date >= window.from && a.date <= window.to;
    return { ...base, verdict: covered ? "seen_not_billed" : "not_judged" };
  });

  const dupIds = new Set(appts.filter(duplicate).map((a) => trim(a.appointmentId)));
  const invoicesNotInFile = invoices.filter((inv) => {
    const k = trim(inv.appointmentId);
    return k !== "" && !seenIds.has(k) && !dupIds.has(k);
  });
  return { appointments: results, invoicesNotInFile };
}

// ---------------------------------------------------------------------------
// Counts, utilisation
// ---------------------------------------------------------------------------

export type Counts = Record<Verdict, number> & { total: number };

export function countVerdicts(results: readonly ApptResult[]): Counts {
  const c: Counts = {
    seen_billed: 0,
    seen_not_billed: 0,
    billed_not_seen: 0,
    cancelled: 0,
    open: 0,
    not_judged: 0,
    review: 0,
    total: 0,
  };
  for (const r of results) {
    c[r.verdict]++;
    c.total++;
  }
  return c;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const hours = (minutes: number) => round2(minutes / 60);

export type Utilisation = {
  key: string;
  name: string;
  /** Appointments that are not cancelled. */
  booked: number;
  seen: number;
  cancelled: number;
  /** Hours of the booked / seen appointments; null when any of them has no duration in the file. */
  bookedHours: number | null;
  seenHours: number | null;
  /** How many booked appointments have no duration in the file. */
  noDuration: number;
  /** Available hours for the month; null = not known (the doctor has no link / the room is not in Rooms). */
  availableHours: number | null;
  /** bookedHours / availableHours and seenHours / availableHours, in percent; null when either side is unknown or 0. */
  bookedPct: number | null;
  seenPct: number | null;
};

type Group = { name: string; names: Map<string, number>; list: ApptIn[] };

function utilisationOf(
  groups: Map<string, Group>,
  available: (key: string) => number | null,
): Utilisation[] {
  const out: Utilisation[] = [];
  for (const [key, g] of groups) {
    const booked = g.list.filter((a) => a.status !== "cancelled");
    const seen = booked.filter((a) => a.status === "honoured");
    const noDuration = booked.filter((a) => a.minutes === null).length;
    const sum = (list: ApptIn[]) => hours(list.reduce((s, a) => s + (a.minutes ?? 0), 0));
    const bookedHours = noDuration === 0 && booked.length > 0 ? sum(booked) : null;
    const seenHours = noDuration === 0 && booked.length > 0 ? sum(seen) : null;
    const avail = available(key);
    const pct = (h: number | null) =>
      h === null || avail === null || avail <= 0 ? null : Math.round((h / avail) * 1000) / 10;
    // the most frequent spelling is the display name
    const name =
      [...g.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key;
    out.push({
      key,
      name,
      booked: booked.length,
      seen: seen.length,
      cancelled: g.list.length - booked.length,
      bookedHours,
      seenHours,
      noDuration,
      availableHours: avail,
      bookedPct: pct(bookedHours),
      seenPct: pct(seenHours),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function group(
  list: readonly ApptIn[],
  keyOf: (a: ApptIn) => string | null,
  nameOf: (a: ApptIn) => string,
) {
  const groups = new Map<string, Group>();
  for (const a of list) {
    const key = keyOf(a);
    if (key === null) continue;
    const g: Group = groups.get(key) ?? { name: "", names: new Map(), list: [] };
    g.list.push(a);
    g.names.set(nameOf(a), (g.names.get(nameOf(a)) ?? 0) + 1);
    groups.set(key, g);
  }
  return groups;
}

/** Utilisation per Unite doctor. `availableHours(doctorKey)` comes from the doctor link and the working hours. */
export function doctorUtilisation(
  appts: readonly ApptIn[],
  availableHours: (doctorKey: string) => number | null,
): Utilisation[] {
  return utilisationOf(
    group(
      appts,
      (a) => a.doctorKey,
      (a) => a.doctorName,
    ),
    availableHours,
  );
}

/** Normalised room text, so "Room 1" and "room  1" are one room. */
export const roomKey = (room: string): string => room.toLowerCase().replace(/\s+/g, " ").trim();

export type RoomUtilisation = Utilisation & { branch: string | null; room: string };

/**
 * Utilisation per room (per branch, because two branches can both have a "Room 1"). Only appointments with a room are
 * counted; `openHours(branch, roomKey)` is the room's open hours when it is in Rooms, else null.
 */
export function roomUtilisation(
  appts: readonly ApptIn[],
  openHours: (branch: string | null, roomKey: string) => number | null,
): RoomUtilisation[] {
  const withRoom = appts.filter((a) => a.room !== null && roomKey(a.room) !== "");
  const groups = group(
    withRoom,
    (a) => `${a.branch ?? ""}|${roomKey(a.room as string)}`,
    (a) => (a.room as string).replace(/\s+/g, " ").trim(),
  );
  const list = utilisationOf(groups, (k) => {
    const [branch, room] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    return openHours(branch === "" ? null : branch, room);
  });
  return list.map((u) => {
    const bar = u.key.indexOf("|");
    const branch = u.key.slice(0, bar);
    return { ...u, branch: branch === "" ? null : branch, room: u.name };
  });
}

// ---------------------------------------------------------------------------
// Branch and coverage helpers
// ---------------------------------------------------------------------------

export type BranchNames = {
  code: string;
  unite_clinic_long_name: string | null;
  unite_clinic_aliases: readonly string[] | null;
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The finance branch of a Unite clinic name: its long name or any of its other names (the rename after 10 Nov 2026),
 * compared exactly after tidying spaces. A blank or unmapped clinic is null (unknown branch).
 */
export function branchOfClinic(
  clinic: string | null,
  branches: readonly BranchNames[],
): string | null {
  const name = squash(clinic ?? "");
  if (name === "") return null;
  const hits = branches.filter(
    (b) =>
      squash(b.unite_clinic_long_name ?? "") === name ||
      (b.unite_clinic_aliases ?? []).some((a) => squash(a) === name),
  );
  return hits.length === 1 ? hits[0].code : null; // one name belongs to one branch only (database guard)
}

/** What the member may see: the page's branch choice narrows, never widens (same rule as the Capacity page). */
export type BranchScope = {
  /** Finance branch codes the member may see; null = every branch. */
  allowed: string[] | null;
  /** The one branch chosen on the page, or null for all of `allowed`. */
  branch: string | null;
  /** False when the chosen branch has no finance branch code, so rows cannot be told apart. */
  available: boolean;
};

/** An unknown branch (null) is visible only to a member who sees every branch and chose none. */
export function branchVisible(scope: BranchScope, branch: string | null): boolean {
  if (!scope.available) return false;
  if (scope.branch !== null) return branch === scope.branch;
  return scope.allowed === null || (branch !== null && scope.allowed.includes(branch));
}

export type DateRange = { from: string; to: string };

/** Overlapping or touching (next-day) ranges joined, sorted. */
export function mergeRanges(list: readonly DateRange[]): DateRange[] {
  const sorted = [...list].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const out: DateRange[] = [];
  const nextDay = (iso: string) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= nextDay(last.to)) last.to = r.to > last.to ? r.to : last.to;
    else out.push({ ...r });
  }
  return out;
}
