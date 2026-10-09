/** Retry schedule: 1 min, 5 min, 30 min, 2 h, 6 h after a failure, then the delivery is marked dead. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** Delay before the next attempt, given how many attempts have been made so far; null = give up. */
export function nextDelaySeconds(attemptsMade: number): number | null {
  if (attemptsMade < 1) return RETRY_DELAYS_SECONDS[0];
  return attemptsMade >= MAX_ATTEMPTS ? null : RETRY_DELAYS_SECONDS[attemptsMade - 1];
}

export type AttemptInput = { status: number } | { error: { name?: string; message?: string; code?: string } };

export type AttemptOutcome = {
  status: "success" | "failed" | "dead";
  responseCode: number | null;
  /** Short and free of response bodies: shown in the delivery log. */
  error: string | null;
  retryInSeconds: number | null;
};

/** Decides what a delivery attempt means. attemptsMade includes the attempt being classified. */
export function classifyAttempt(result: AttemptInput, attemptsMade: number): AttemptOutcome {
  if ("status" in result) {
    const code = result.status;
    if (code >= 200 && code < 300) return { status: "success", responseCode: code, error: null, retryInSeconds: null };
    if (code === 410) return { status: "dead", responseCode: code, error: "HTTP 410: the endpoint reported it is gone.", retryInSeconds: null };
    const error = code >= 300 && code < 400 ? `HTTP ${code}: redirects are not followed.` : `HTTP ${code}`;
    return retry(code, error, attemptsMade);
  }
  if (result.error.name === "UnsafeUrlError") {
    return { status: "dead", responseCode: null, error: "Blocked: the endpoint resolves to a non-public address.", retryInSeconds: null };
  }
  const message = /timed out/i.test(result.error.message ?? "") ? "Timed out waiting for a response." : "Could not connect to the endpoint.";
  return retry(null, message, attemptsMade);
}

function retry(responseCode: number | null, error: string, attemptsMade: number): AttemptOutcome {
  const delay = nextDelaySeconds(attemptsMade);
  return delay === null
    ? { status: "dead", responseCode, error: `${error} Gave up after ${attemptsMade} attempts.`, retryInSeconds: null }
    : { status: "failed", responseCode, error, retryInSeconds: delay };
}
