/**
 * Everything a flow node can do to the outside world, behind one interface. The executors are
 * pure functions over (node config, scope, ports) so each one is unit-tested with a fake;
 * lib/flow-engine/ports-db.ts is the real implementation (service role, after the run's org check).
 */
import type { FlowOption } from "@/lib/flow-engine/types";

export class FlowNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowNodeError";
  }
}

export type EnquiryInput = {
  action: "create" | "update";
  pipelineId?: string;
  stageId?: string;
  status?: "open" | "won" | "lost";
  subject?: string;
};

export type TaskInput = { subject: string; notes?: string; dueAt: Date; assigneeId?: string };

export type PortalInput = {
  objectKey: string;
  action: "create" | "update";
  recordId?: string;
  values: Record<string, string>;
};

export type AppointmentInput =
  | { action: "set_status"; status: "confirmed" | "cancelled"; appointmentId?: string }
  | {
      action: "create";
      specialistId?: string;
      locationId?: string;
      startsAt: Date;
      durationMinutes?: number;
    };

export type HttpInput = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export interface FlowPorts {
  now(): Date;
  timezone: string;
  /** False for runs started by a webhook / schedule / enquiry that have no open conversation. */
  hasConversation: boolean;
  sendText(text: string): Promise<void>;
  sendButtons(text: string, options: FlowOption[]): Promise<void>;
  sendList(text: string, buttonLabel: string, options: FlowOption[]): Promise<void>;
  sendTemplate(templateId: string, values: Record<string, string>): Promise<void>;
  assign(target: { userId?: string; teamId?: string }): Promise<void>;
  closeConversation(): Promise<void>;
  addComment(text: string): Promise<void>;
  updateContact(patch: Record<string, string>): Promise<void>;
  upsertEnquiry(input: EnquiryInput): Promise<{ id: string }>;
  createTask(input: TaskInput): Promise<{ id: string }>;
  portalRecord(input: PortalInput): Promise<{ id: string }>;
  appointment(input: AppointmentInput): Promise<{ id: string | null }>;
  httpRequest(input: HttpInput): Promise<{ status: number; text: string }>;
  notify(input: {
    userId?: string;
    permission?: string;
    title: string;
    body?: string;
  }): Promise<number>;
}
