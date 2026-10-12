/**
 * The settings schema each node type is executed with. One map so the engine, the builder checks and the Flow Copilot's
 * validator all read the SAME contract. Types whose settings are free-form ports (CRM nodes) accept any object.
 */
import { z } from "zod";

import { assignSchema } from "@/lib/flow-engine/executors/conversation";
import { updateFieldSchema } from "@/lib/flow-engine/executors/crm";
import { apiSchema, notifySchema } from "@/lib/flow-engine/executors/integrations";
import { branchSchema, runFlowSchema, waitSchema } from "@/lib/flow-engine/executors/logic";
import {
  messageSchema,
  questionSchema,
  quickReplySchema,
  templateSchema,
} from "@/lib/flow-engine/executors/messaging";
import { officeHoursSchema } from "@/lib/flow-engine/office-hours";
import type { NodeType } from "@/lib/flow-engine/types";

const loose = z.record(z.string(), z.unknown());
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
  create_enquiry: loose,
  add_task: loose,
  portal_record: loose,
  book_appointment: loose,
  api_action: apiSchema,
  send_notification: notifySchema,
};
