import type { BoardRow, DoctorSlots } from "@/lib/front-desk/server";

export type { DeskOptions } from "@/lib/front-desk/options";

export type DeskCan = {
  /** appointments.manage: book, move, cancel, check in, waiting list. */
  appointments: boolean;
  /** contacts.manage: walk-in registration and households. */
  contacts: boolean;
  /** tasks.manage: log a call. */
  tasks: boolean;
  /** inbox.send: location and running-late messages. */
  send: boolean;
};

export type WaitlistRow = {
  id: string;
  contact_id: string;
  patient_name: string;
  specialist_name: string | null;
  service_name: string | null;
  location_name: string | null;
  not_after: string | null;
  notes: string | null;
  created_at: string;
  /** An offer for a freed slot is out to this person right now. */
  offer: { starts_at: string; expires_at: string } | null;
  /** The newest offer to this person could not be sent (reason code, e.g. window_closed_no_template). */
  offerFailure: string | null;
};

export type NoteRow = {
  id: string;
  body: string;
  pinned: boolean;
  created_at: string;
  author: string | null;
  resolved_at: string | null;
};

export type DeskData = {
  date: string;
  today: string;
  rows: BoardRow[];
  slots: DoctorSlots[];
  waitlist: WaitlistRow[];
  notes: NoteRow[];
  lateGraceMin: number;
  offersEnabled: boolean;
};
