import { config } from '../config/env';

export type JobHandler = (
  payload: Record<string, unknown>
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

async function simulateReviewAnalysis(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const review = typeof payload.review === 'string' ? payload.review : '';

  await sleep(config.workerTaskDelayMs);

  return {
    review,
    processed: true,
    summary: 'Simulated review analysis completed',
    reviewFingerprint: fnv1a(review),
  };
}