export type TasksBootstrap = {
  orgId: string;
  userId: string;
  timezone: string;
  users: Array<{ id: string; label: string }>;
  can: {
    manage: boolean;
    /** May search contacts / enquiries in the task pickers. */
    contacts: boolean;
    enquiries: boolean;
  };
};
