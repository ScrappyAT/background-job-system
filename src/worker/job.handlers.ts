import { config } from '../config/env';

export interface JobContext {
  attempt: number;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  context: JobContext
) => Promise<Record<string, unknown>>;

const handlers: Record<string, JobHandler> = {
  review_analysis: simulateReviewAnalysis,
};

export function getHandler(type: string): JobHandler | undefined {
  return handlers[type];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const TEST_PROCESSING_DELAY_MAX_MS = 120000;

async function simulateReviewAnalysis(
  payload: Record<string, unknown>,
  context: JobContext
): Promise<Record<string, unknown>> {
  const review = typeof payload.review === 'string' ? payload.review : '';
  const testFailureMode = payload.testFailureMode;
  const overrideDelayMs =
    typeof payload.testProcessingDelayMs === 'number'
      ? Math.min(
          TEST_PROCESSING_DELAY_MAX_MS,
          Math.max(0, Math.trunc(payload.testProcessingDelayMs))
        )
      : null;

  await sleep(overrideDelayMs ?? config.workerTaskDelayMs);

  if (testFailureMode === 'always') {
    throw new Error('Simulated failure: testFailureMode=always');
  }
  if (testFailureMode === 'once' && context.attempt === 1) {
    throw new Error('Simulated failure: testFailureMode=once (attempt 1)');
  }

  return {
    review,
    processed: true,
    summary: 'Simulated review analysis completed',
    reviewFingerprint: fnv1a(review),
  };
}