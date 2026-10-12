import { z } from "zod";

/**
 * The Overview dashboard tiles come from ONE SQL call (public.dashboard_overview, security invoker, so the
 * caller's own row-level security decides what they can count). This parses its JSON defensively: a missing
 * section is zeros, never a crash.
 */
const n = z.coerce.number().int().nonnegative().catch(0);

const overviewSchema = z.object({
  conversations: z
    .object({ mine: n, unassigned: n, waiting: n, unread_mine: n })
    .catch({ mine: 0, unassigned: 0, waiting: 0, unread_mine: 0 }),
  team: z.object({ members: n, online: n }).catch({ members: 0, online: 0 }),
  tasks: z.object({ open: n, overdue: n }).nullable().catch(null),
  enquiries: z.object({ open: n, new_today: n }).nullable().catch(null),
});

export type DashboardOverview = z.infer<typeof overviewSchema>;

export function parseDashboardOverview(json: unknown): DashboardOverview {
  const parsed = overviewSchema.safeParse(json ?? {});
  return parsed.success
    ? parsed.data
    : {
        conversations: { mine: 0, unassigned: 0, waiting: 0, unread_mine: 0 },
        team: { members: 0, online: 0 },
        tasks: null,
        enquiries: null,
      };
}
