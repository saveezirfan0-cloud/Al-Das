/**
 * Capacity measures for one month (M3, docs/23_PHASE_M3A_NOTES.md). Pure: the server loader gathers the inputs.
 *
 *   doctor  available hours (lib/capacity/hours.ts), revenue (Unite collection report, through the doctor-key links),
 *           revenue per available hour
 *   room    rota hours, open hours (open days x room_open_hours_per_day), occupancy = rota / open, revenue attributed
 *           from each doctor by their share of rota hours in that room, revenue per room-hour, cost per rota hour
 *
 * Money is handled in thousandths (the report's precision) and split with the largest-remainder method, so a doctor's
 * attributed shares always add up to exactly their revenue. A doctor with revenue but no rota hours stays unattributed
 * (shown as such), never spread over rooms they do not use. An unknown room cost (null) stays unknown: it is never 0.
 * Appointment-based utilisation (booked / available) waits for the Unite appointment feed and is not computed here.
 */

export type CapacityDoctorInput = {
  specialistId: string;
  name: string;
  availableMinutes: number;
  /** Revenue in AED for the month, or null when the doctor has no link to a Unite report doctor key. */
  revenue: number | null;
};

export type CapacityRoomInput = {
  id: string;
  name: string;
  locationName: string;
  kind: string;
  /** AED per month; null = unknown. */
  monthlyCost: number | null;
};

export type CapacityInputs = {
  /** Open days in the month (working week, minus holidays). */
  openDays: number;
  openHoursPerDay: number;
  /** False when revenue cannot be scoped to the chosen branch (no finance branch code): every revenue is null. */
  revenueAvailable: boolean;
  doctors: readonly CapacityDoctorInput[];
  rooms: readonly CapacityRoomInput[];
  /** room id -> doctor id -> rota minutes in the month. */
  rota: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

export type DoctorCapacity = {
  specialistId: string;
  name: string;
  availableHours: number;
  rotaHours: number;
  revenue: number | null;
  revenuePerAvailableHour: number | null;
};

export type RoomCapacity = {
  id: string;
  name: string;
  locationName: string;
  kind: string;
  rotaHours: number;
  openHours: number;
  /** Rota hours / open hours (0..n; over 1 means the rota is longer than the opening hours setting). */
  occupancy: number | null;
  /** Null when no revenue is known for any doctor on its rota. */
  revenue: number | null;
  revenuePerRoomHour: number | null;
  monthlyCost: number | null;
  costPerRotaHour: number | null;
};

export type CapacityReport = {
  doctors: DoctorCapacity[];
  rooms: RoomCapacity[];
  totals: {
    availableHours: number;
    rotaHours: number;
    openHours: number;
    revenue: number | null;
    attributedRevenue: number | null;
    /** Revenue of linked doctors who have no rota hours in scope. */
    unattributedRevenue: number | null;
  };
};

const mils = (v: number) => Math.round(v * 1000);
const fromMils = (v: number) => v / 1000;
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const per = (amount: number | null, h: number) =>
  amount === null || h <= 0 ? null : Math.round((amount / h) * 100) / 100;

/**
 * Splits `total` (integer thousandths, may be negative) over `weights` in proportion, largest remainder first, so the
 * parts add up to `total` exactly. Ties go to the earlier weight. All-zero weights give all-zero parts.
 */
export function splitByWeight(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * Math.max(0, w)) / sum);
  const parts = raw.map(Math.floor);
  let left = abs - parts.reduce((s, p) => s + p, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .filter((x) => weights[x.i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--)
    parts[order[k].i] += 1;
  return parts.map((p) => p * sign);
}

export function buildCapacityReport(inputs: CapacityInputs): CapacityReport {
  const revenueOf = (d: CapacityDoctorInput) => (inputs.revenueAvailable ? d.revenue : null);

  // Each doctor's rota minutes per room and in total.
  const doctorRooms = new Map<string, { roomId: string; minutes: number }[]>();
  for (const [roomId, byDoctor] of inputs.rota)
    for (const [doctorId, minutes] of byDoctor) {
      if (minutes <= 0) continue;
      const list = doctorRooms.get(doctorId) ?? [];
      list.push({ roomId, minutes });
      doctorRooms.set(doctorId, list);
    }

  const roomMils = new Map<string, number>();
  const roomHasRevenue = new Set<string>();
  let attributed = 0;
  let unattributed = 0;
  let anyRevenue = false;
  for (const d of inputs.doctors) {
    const rev = revenueOf(d);
    if (rev === null) continue;
    anyRevenue = true;
    const rooms = (doctorRooms.get(d.specialistId) ?? []).sort((a, b) =>
      a.roomId.localeCompare(b.roomId),
    );
    const total = mils(rev);
    if (rooms.length === 0) {
      unattributed += total;
      continue;
    }
    const parts = splitByWeight(
      total,
      rooms.map((r) => r.minutes),
    );
    rooms.forEach((r, i) => {
      roomMils.set(r.roomId, (roomMils.get(r.roomId) ?? 0) + parts[i]);
      roomHasRevenue.add(r.roomId);
    });
    attributed += total;
  }

  const doctors: DoctorCapacity[] = inputs.doctors
    .map((d) => {
      const availableHours = hours(d.availableMinutes);
      const rota = (doctorRooms.get(d.specialistId) ?? []).reduce((s, r) => s + r.minutes, 0);
      const revenue = revenueOf(d);
      return {
        specialistId: d.specialistId,
        name: d.name,
        availableHours,
        rotaHours: hours(rota),
        revenue,
        revenuePerAvailableHour: per(revenue, availableHours),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const openHours = Math.round(inputs.openDays * inputs.openHoursPerDay * 100) / 100;
  const rooms: RoomCapacity[] = inputs.rooms
    .map((r) => {
      const minutes = [...(inputs.rota.get(r.id)?.values() ?? [])].reduce((s, m) => s + m, 0);
      const rotaHours = hours(minutes);
      const revenue = roomHasRevenue.has(r.id) ? fromMils(roomMils.get(r.id) ?? 0) : null;
      const cost = r.monthlyCost !== null && r.monthlyCost > 0 ? r.monthlyCost : null;
      return {
        id: r.id,
        name: r.name,
        locationName: r.locationName,
        kind: r.kind,
        rotaHours,
        openHours,
        occupancy: openHours > 0 ? Math.round((rotaHours / openHours) * 10000) / 10000 : null,
        revenue,
        revenuePerRoomHour: per(revenue, rotaHours),
        monthlyCost: cost,
        costPerRotaHour: per(cost, rotaHours),
      };
    })
    .sort((a, b) => a.locationName.localeCompare(b.locationName) || a.name.localeCompare(b.name));

  const revenueKnown = inputs.revenueAvailable && anyRevenue;
  return {
    doctors,
    rooms,
    totals: {
      availableHours: Math.round(doctors.reduce((s, d) => s + d.availableHours, 0) * 100) / 100,
      rotaHours: Math.round(rooms.reduce((s, r) => s + r.rotaHours, 0) * 100) / 100,
      openHours: Math.round(openHours * rooms.length * 100) / 100,
      revenue: revenueKnown ? fromMils(attributed + unattributed) : null,
      attributedRevenue: revenueKnown ? fromMils(attributed) : null,
      unattributedRevenue: revenueKnown ? fromMils(unattributed) : null,
    },
  };
}

/** Revenue per Pulse doctor from the report's (doctor key, revenue) rows and the key links; unlinked keys listed apart. */
export function revenueByDoctor(
  rows: readonly { doctorKey: string; doctorName: string; revenue: number }[],
  links: ReadonlyMap<string, string>,
): {
  bySpecialist: Map<string, number>;
  unlinked: { doctorKey: string; doctorName: string; revenue: number }[];
} {
  const bySpecialistMils = new Map<string, number>();
  const unlinked = new Map<string, { doctorKey: string; doctorName: string; mils: number }>();
  for (const r of rows) {
    const specialist = links.get(r.doctorKey);
    if (specialist) {
      bySpecialistMils.set(specialist, (bySpecialistMils.get(specialist) ?? 0) + mils(r.revenue));
    } else {
      const u = unlinked.get(r.doctorKey) ?? {
        doctorKey: r.doctorKey,
        doctorName: r.doctorName,
        mils: 0,
      };
      u.mils += mils(r.revenue);
      unlinked.set(r.doctorKey, u);
    }
  }
  return {
    bySpecialist: new Map([...bySpecialistMils].map(([k, v]) => [k, fromMils(v)])),
    unlinked: [...unlinked.values()]
      .map((u) => ({ doctorKey: u.doctorKey, doctorName: u.doctorName, revenue: fromMils(u.mils) }))
      .sort((a, b) => b.revenue - a.revenue || a.doctorName.localeCompare(b.doctorName)),
  };
}
