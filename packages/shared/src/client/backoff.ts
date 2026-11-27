export interface BackoffOptions {
  /** Delay ceiling for the first retry, in ms. */
  initialDelayMs: number;
  /** Upper bound for any single delay, in ms. */
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 250,
  maxDelayMs: 10_000,
};

/**
 * Exponential backoff with "full jitter" (AWS architecture blog): the delay is drawn
 * uniformly from [0, min(max, initial * 2^attempt)]. Jitter matters here: after a server
 * restart every client reconnects at once, and without it they would retry in lockstep.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * ceiling);
}
