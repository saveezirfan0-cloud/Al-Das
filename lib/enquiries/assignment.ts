/** Who a new enquiry goes to. Pure decision; the service performs the round-robin RPC. */
import type { EnquirySettings } from "@/lib/enquiries/settings";

export type AssignmentDecision =
  | { kind: "user"; userId: string }
  | { kind: "team_round_robin"; teamId: string }
  | { kind: "none" };

export function decideAssignment(args: {
  requestedAssigneeId?: string | null;
  creatorId: string | null;
  pipelineTeamId: string | null;
  mode: EnquirySettings["assignment"]["mode"];
}): AssignmentDecision {
  if (args.requestedAssigneeId) return { kind: "user", userId: args.requestedAssigneeId };
  switch (args.mode) {
    case "creator":
      return args.creatorId ? { kind: "user", userId: args.creatorId } : { kind: "none" };
    case "round_robin":
      return args.pipelineTeamId
        ? { kind: "team_round_robin", teamId: args.pipelineTeamId }
        : { kind: "none" };
    default:
      return { kind: "none" };
  }
}
