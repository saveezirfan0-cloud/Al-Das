/** Who is told about a possible emergency. PURE. Order is irrelevant; duplicates and blanks are dropped. */
export function planEmergencyRecipients(input: {
  ownerId: string | null;
  teamLeadId: string | null;
  onCallIds: readonly string[];
  /** Used only when nobody else would be told. */
  adminIds: readonly string[];
}): string[] {
  const direct = [input.ownerId, input.teamLeadId, ...input.onCallIds].filter(
    (v): v is string => !!v,
  );
  const chosen = direct.length > 0 ? direct : [...input.adminIds];
  return [...new Set(chosen)];
}

/** Emergency notifications for one conversation are spaced out so a patient typing "help" five times does not page five times. */
export const EMERGENCY_NOTIFY_WINDOW_MINUTES = 10;

export function withinNotifyWindow(lastEscalatedAt: Date | null, now: Date): boolean {
  return (
    !!lastEscalatedAt &&
    now.getTime() - lastEscalatedAt.getTime() < EMERGENCY_NOTIFY_WINDOW_MINUTES * 60_000
  );
}
