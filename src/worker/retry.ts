const MAX_DELAY_MS = 2 ** 31 - 1;

export interface RetrySchedule {
  attempt: number;
  exponentialDelayMs: number;
  jitterMs: number;
  delayMs: number;
  runAt: Date;
}

export function computeRetryDelay(
  attempt: number,
  baseDelayMs: number
): RetrySchedule {
  const exponentialDelayMs = Math.min(
    MAX_DELAY_MS,
    Math.pow(2, attempt - 1) * Math.max(1, baseDelayMs)
  );
  const jitterMs = randomIntInclusive(0, Math.max(0, baseDelayMs));
  const delayMs = Math.min(MAX_DELAY_MS, exponentialDelayMs + jitterMs);

  return {
    attempt,
    exponentialDelayMs,
    jitterMs,
    delayMs,
    runAt: new Date(Date.now() + delayMs),
  };
}

function randomIntInclusive(min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return min + Math.floor(Math.random() * (max - min + 1));
}