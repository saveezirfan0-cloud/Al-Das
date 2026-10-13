/**
 * The settings schema each node type is executed with. One map so the engine, the builder checks and the Flow Copilot's
 * validator all read the SAME contract.
 */
import { z } from "zod";

import { aiRouterSchema } from "@/lib/flow-engine/executors/ai";
import { assignSchema } from "@/lib/flow-engine/executors/conversation";
import {
  addTaskSchema,
  bookAppointmentSchema,
  createEnquirySchema,
  portalRecordSchema,
  setLabelSchema,
  updateEnquirySchema,
  updateFieldSchema,
} from "@/lib/flow-engine/executors/crm";
import {
  apiSchema,
  metaEventSchema,
  notifySchema,
  paymentLinkSchema,
} from "@/lib/flow-engine/executors/integrations";
import { branchSchema, runFlowSchema, waitSchema } from "@/lib/flow-engine/executors/logic";
import {
  messageSchema,
  questionSchema,
  quickReplySchema,
  templateSchema,
} from "@/lib/flow-engine/executors/messaging";
import { officeHoursSchema } from "@/lib/flow-engine/office-hours";
import type { NodeType } from "@/lib/flow-engine/types";

const empty = z.object({});

export const NODE_DATA_SCHEMAS: Record<NodeType, z.ZodTypeAny> = {
  trigger: empty,
  message: messageSchema,
  question: questionSchema,
  quick_reply: quickReplySchema,
  template: templateSchema,
  branch: branchSchema,
  wait: waitSchema,
  office_hours: officeHoursSchema,
  run_flow: runFlowSchema,
  end_flow: empty,
  assign_to: z.object({ target: assignSchema }),
  close_conversation: empty,
  add_comment: z.object({ text: z.string().min(1).max(4000) }),
  update_contact_field: updateFieldSchema,
  create_enquiry: createEnquirySchema,
  add_task: addTaskSchema,
  portal_record: portalRecordSchema,
  book_appointment: bookAppointmentSchema,
  update_enquiry: updateEnquirySchema,
  set_label: setLabelSchema,
  api_action: apiSchema,
  send_notification: notifySchema,
  payment_link: paymentLinkSchema,
  meta_event: metaEventSchema,
  ai_router: aiRouterSchema,
};
