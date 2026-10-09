import { add_comment, assign_to, close_conversation } from "@/lib/flow-engine/executors/conversation";
import type { Executor } from "@/lib/flow-engine/executors/common";
import { add_task, book_appointment, create_enquiry, portal_record, update_contact_field } from "@/lib/flow-engine/executors/crm";
import { api_action, send_notification } from "@/lib/flow-engine/executors/integrations";
import { branch, end_flow, office_hours, run_flow, trigger, wait } from "@/lib/flow-engine/executors/logic";
import { message, question, quick_reply, template } from "@/lib/flow-engine/executors/messaging";
import type { NodeType } from "@/lib/flow-engine/types";

export const EXECUTORS: Record<NodeType, Executor> = {
  trigger,
  message,
  question,
  quick_reply,
  template,
  branch,
  wait,
  office_hours,
  run_flow,
  end_flow,
  assign_to,
  close_conversation,
  add_comment,
  update_contact_field,
  create_enquiry,
  add_task,
  portal_record,
  book_appointment,
  api_action,
  send_notification,
};
