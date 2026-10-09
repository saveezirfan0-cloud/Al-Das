import type { TaskType } from "@/lib/tasks/due";

export type TaskRow = {
  id: string;
  type: TaskType;
  subject: string;
  notes: string | null;
  due_at: string | null;
  assignee_id: string | null;
  assignee_name: string;
  contact_id: string | null;
  patient: string;
  enquiry_id: string | null;
  enquiry_number: number | null;
  appointment_id: string | null;
  done: boolean;
  done_at: string | null;
  created_at: string;
  created_by_name: string;
};
