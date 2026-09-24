import { config } from '../config/env';

import { analyzeReview } from './deepseek.client';

export interface JobContext {
  attempt: number;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  context: JobContext
) => Promise<Record<string, unknown>>;

const handlers: Record<string, JobHandler> = {
  review_analysis: reviewAnalysis,
};

export function getHandler(type: string): JobHandler | undefined {
  return handlers[type];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEST_PROCESSING_DELAY_MAX_MS = 120000;

async function reviewAnalysis(
  payload: Record<string, unknown>,
  context: JobContext
): Promise<Record<string, unknown>> {
  const review = typeof payload.review === 'string' ? payload.review : '';
  if (review === '') {
    throw new Error('review payload is missing or empty');
  }
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

  return analyzeReview(review);
}