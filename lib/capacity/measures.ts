/**
 * Capacity measures for one month (M3, docs/23_PHASE_M3A_NOTES.md). Pure: the server loader gathers the inputs.
 *
 *   doctor  available hours (lib/capacity/hours.ts), revenue (Unite collection report, through the doctor-key links),
 *           revenue per available hour
 *   room    open hours (open days x room_open_hours_per_day) and monthly cost. Rota hours, occupancy and revenue per
 *           room-hour need the staff rota (rota_shifts, PR #72) linked to rooms, and are not computed here yet.
 *
 * Money is summed in thousandths (the report's precision). An unknown room cost (null) stays unknown: it is never 0.
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
};

export type DoctorCapacity = {
  specialistId: string;
  name: string;
  availableHours: number;
  revenue: number | null;
  revenuePerAvailableHour: number | null;
};

export type RoomCapacity = {
  id: string;
  name: string;
  locationName: string;
  kind: string;
  openHours: number;
  monthlyCost: number | null;
};

export type CapacityReport = {
  doctors: DoctorCapacity[];
  rooms: RoomCapacity[];
  totals: {
    availableHours: number;
    /** Linked doctors' revenue in scope; null when no revenue is known. */
    revenue: number | null;
    /** Revenue per available hour over the doctors who have both (linked revenue and available hours). */
    revenuePerAvailableHour: number | null;
  };
};

const mils = (v: number) => Math.round(v * 1000);
const fromMils = (v: number) => v / 1000;
const round2 = (v: number) => Math.round(v * 100) / 100;
const hours = (minutes: number) => round2(minutes / 60);
const per = (amount: number | null, h: number) =>
  amount === null || h <= 0 ? null : round2(amount / h);

export function buildCapacityReport(inputs: CapacityInputs): CapacityReport {
  const doctors: DoctorCapacity[] = inputs.doctors
    .map((d) => {
      const availableHours = hours(d.availableMinutes);
      const revenue = inputs.revenueAvailable ? d.revenue : null;
      return {
        specialistId: d.specialistId,
        name: d.name,
        availableHours,
        revenue,
        revenuePerAvailableHour: per(revenue, availableHours),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const openHours = round2(inputs.openDays * inputs.openHoursPerDay);
  const rooms: RoomCapacity[] = inputs.rooms
    .map((r) => ({
      id: r.id,
      name: r.name,
      locationName: r.locationName,
      kind: r.kind,
      openHours,
      monthlyCost: r.monthlyCost !== null && r.monthlyCost > 0 ? r.monthlyCost : null,
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName) || a.name.localeCompare(b.name));

  const linked = doctors.filter((d) => d.revenue !== null);
  const paired = linked.filter((d) => d.availableHours > 0);
  const pairedHours = paired.reduce((s, d) => s + d.availableHours, 0);
  return {
    doctors,
    rooms,
    totals: {
      availableHours: round2(doctors.reduce((s, d) => s + d.availableHours, 0)),
      revenue:
        linked.length > 0 ? fromMils(linked.reduce((s, d) => s + mils(d.revenue ?? 0), 0)) : null,
      revenuePerAvailableHour: per(
        fromMils(paired.reduce((s, d) => s + mils(d.revenue ?? 0), 0)),
        pairedHours,
      ),
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
