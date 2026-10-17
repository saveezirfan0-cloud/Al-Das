/**
 * Synthetic Unite appointment export for tests (W2). Made-up doctors, PINs and ids only. The columns Pulse must never
 * read (patient name, date of birth, Emirates ID, phone, insurance member id) hold SENTINELS.
 */

export const SENTINELS = {
  name: "SENTINEL-PATIENT-NAME",
  dob: "SENTINEL-DOB-1980",
  emiratesId: "784-SENTINEL-EID",
  phone: "SENTINEL-PHONE-0500000",
  memberId: "SENTINEL-MEMBER-ID",
} as const;

export const HEADERS = [
  "Appointment ID",
  "Appointment Date",
  "Start Time",
  "End Time",
  "Appointment Status",
  "Doctor Name",
  "Room",
  "Clinic Name",
  "PIN",
  "Patient Name",
  "Date of Birth",
  "Emirates ID",
  "Mobile",
  "Member ID",
] as const;

export type ApptFixtureRow = {
  id: string | number | null;
  date: Date | string | number | null;
  start?: Date | string | number | null;
  end?: Date | string | number | null;
  status: string | null;
  doctor: string | null;
  room?: string | null;
  clinic?: string | null;
  pin?: string | number | null;
};

/** Wall-clock date (time of day optional) as exceljs returns it: the Excel value in the UTC fields. */
export const wall = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm));
/** A time of day as exceljs returns it for a time-only cell. */
export const clock = (hh: number, mm = 0) => new Date(Date.UTC(1899, 11, 30, hh, mm));

export const DEFAULT_ROWS: ApptFixtureRow[] = [
  {
    id: 1001,
    date: wall(2026, 9, 1),
    start: clock(9, 0),
    end: clock(9, 30),
    status: "Honoured",
    doctor: "Dr. Omar Testdoc",
    room: "Room 1",
    clinic: "Al Das Synthetic Clinic One",
    pin: 9000001,
  },
  {
    id: 1002,
    date: wall(2026, 9, 1),
    start: clock(10, 0),
    end: clock(10, 30),
    status: "Honoured",
    doctor: "Dr.Omar  Testdoc",
    room: "room 1",
    clinic: "Al Das Synthetic Clinic One",
    pin: "9000002",
  },
  {
    id: 1003,
    date: wall(2026, 9, 1),
    start: clock(11, 0),
    end: clock(11, 30),
    status: "Cancelled",
    doctor: "Dr. Omar Testdoc",
    room: "Room 1",
    clinic: "Al Das Synthetic Clinic One",
    pin: 9000003,
  },
  {
    id: 1004,
    date: wall(2026, 9, 2),
    start: clock(9, 0),
    end: clock(10, 0),
    status: "Confirmed",
    doctor: "Dr. Lina Testdoc",
    room: "Room 2",
    clinic: "Al Das Synthetic Clinic One",
    pin: 9000004,
  },
  {
    id: 1005,
    date: wall(2026, 9, 2),
    start: clock(10, 0),
    end: clock(10, 30),
    status: "Awaiting Confirmation",
    doctor: "Dr. Lina Testdoc",
    room: "Room 2",
    clinic: "Al Das Synthetic Clinic One",
    pin: 9000005,
  },
];

export async function buildAppointmentWorkbook(
  rows: ApptFixtureRow[] = DEFAULT_ROWS,
  opts: { headers?: readonly string[]; titleLines?: number; footer?: boolean } = {},
): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Appointments");
  for (let i = 0; i < (opts.titleLines ?? 0); i++) ws.addRow([`Appointment report line ${i + 1}`]);
  ws.addRow([...(opts.headers ?? HEADERS)]);
  for (const r of rows)
    ws.addRow([
      r.id,
      r.date,
      r.start ?? null,
      r.end ?? null,
      r.status,
      r.doctor,
      r.room ?? null,
      r.clinic ?? null,
      r.pin ?? null,
      SENTINELS.name,
      SENTINELS.dob,
      SENTINELS.emiratesId,
      SENTINELS.phone,
      SENTINELS.memberId,
    ]);
  if (opts.footer) ws.addRow(["Total", null, null, null, null, null, null, null, null]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
