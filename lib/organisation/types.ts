/** Shapes the Organisation pages (Doctors, Staff, Rota, My day) hand to the browser. Framework-free. */
import type { DoctorLinkSuggestions } from "@/lib/organisation/doctor-links";
import type { DutyFrequency, EmploymentType } from "@/lib/organisation/staff";
import type { RotaRole } from "@/lib/organisation/rota";

export type Option = { value: string; label: string };
export type BranchOption = { id: string; name: string; timezone: string };

export type DoctorRow = {
  id: string;
  name: string;
  title: string | null;
  specialty: string | null;
  departmentName: string | null;
  active: boolean;
  locationIds: string[];
  locationNames: string[];
  servicesCount: number;
  licenceNumber: string | null;
  licenceAuthority: string;
  licenceExpiresOn: string | null;
  phoneExt: string | null;
  bio: string | null;
  userId: string | null;
  userLabel: string | null;
  /** The Unite report doctor key this doctor is linked to; only filled for viewers with finance.revenue.view. */
  reportDoctorKey: string | null;
  todayCount: number;
  hours: Array<{ locationId: string; locationName: string; text: string }>;
  timeOff: Array<{ id: string; startsAt: string; endsAt: string; reason: string | null }>;
};

export type StaffRow = {
  id: string;
  fullName: string;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  homeLocationId: string | null;
  homeLocationName: string | null;
  managerStaffId: string | null;
  managerName: string | null;
  employmentType: EmploymentType;
  startDate: string | null;
  endDate: string | null;
  workEmail: string | null;
  workPhone: string | null;
  visaExpiresOn: string | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
  notes: string | null;
  profileId: string | null;
  profileLabel: string | null;
  specialistId: string | null;
  specialistName: string | null;
  archived: boolean;
};

export type DutyRow = {
  id: string;
  title: string;
  frequency: DutyFrequency;
  locationId: string | null;
  active: boolean;
};

export type ShiftRow = {
  id: string;
  staffMemberId: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  roleLabel: RotaRole;
  room: string | null;
  notes: string | null;
};

/** The doctor drawer's linked view: what is booked next, who is on this week, and the HR record. */
export type DoctorDetail = {
  /** The next appointments (null when the viewer may not see the diary). Patients by first name or initials only. */
  upcoming: Array<{
    id: string;
    when: string;
    service: string | null;
    branch: string | null;
    patient: string;
  }> | null;
  /** This week's rota shifts of the doctor's staff record, in the branches the viewer may see. */
  shifts: Array<{ id: string; day: string; time: string; branch: string | null; role: string }>;
  /** The linked staff record (null when there is none, or the viewer has no hr.view). */
  staff: { id: string; jobTitle: string | null } | null;
};

/**
 * The doctor drawer's Finance link (finance.reference.manage only): the linked finance doctor (DHA id) and Unite report
 * name, the suggestions, and the options a person may pick (those not linked to another doctor).
 */
export type DoctorFinanceLink = {
  finance: { dhaId: string; label: string; missing: boolean } | null;
  report: { key: string; label: string; missing: boolean } | null;
  suggestions: DoctorLinkSuggestions;
  /** What the picker shows for the suggested (or taken) value of each kind. */
  suggestedLabels: { finance: string | null; report: string | null };
  financeOptions: Option[];
  reportOptions: Option[];
};
