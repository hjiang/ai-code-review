/**
 * Retry helpers with exponential backoff.
 */

/** Backoff in ms: 2s, 8s, 32s, then capped at 32s, with ±20% jitter. */
export function backoffMs(attempt: number): number {
  const base = [2000, 8000, 32000][attempt] ?? 32000;
  const jitter = Math.random() * 0.4 - 0.2; // ±20%
  return Math.round(base * (1 + jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
