export type TasksBootstrap = {
  orgId: string;
  userId: string;
  timezone: string;
  users: Array<{ id: string; label: string }>;
  /** Phase F: teams a task can belong to. */
  teams: Array<{ id: string; name: string }>;
  /** Phase B: branches this member may pick (active), every branch's name, and the switcher's branch. */
  branches: Array<{ id: string; name: string }>;
  branchNames: Record<string, string>;
  currentBranch: string | null;
  can: {
    manage: boolean;
    /** May search contacts / enquiries in the task pickers. */
    contacts: boolean;
    enquiries: boolean;
    /** Daily checklist templates (settings.manage). */
    settings: boolean;
    /** Attach files from the Media Library (media.view or media.manage). */
    media: boolean;
  };
};
