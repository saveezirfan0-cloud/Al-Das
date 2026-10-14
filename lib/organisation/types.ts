/** Shapes the Organisation pages (Doctors, Staff, Rota, My day) hand to the browser. Framework-free. */
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
