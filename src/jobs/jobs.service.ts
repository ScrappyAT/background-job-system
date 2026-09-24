import { config } from '../config/env';
import { ApiError } from '../http/errors';

import { JobApi, toApiJob } from './job.model';
import { findJobById, findJobByIdempotencyKey, insertJob } from './jobs.repository';

export interface EnqueuedJob {
  job: JobApi;
  duplicate: boolean;
}

export async function enqueueReviewJob(input: {
  review: string;
  idempotencyKey: string;
  testFailureMode?: 'always' | 'once';
}): Promise<EnqueuedJob> {
  const created = await insertJob({
    review: input.review,
    idempotencyKey: input.idempotencyKey,
    testFailureMode: input.testFailureMode,
    maxAttempts: config.jobMaxAttempts,
  });

  if (created) {
    return { job: toApiJob(created), duplicate: false };
  }

  const existing = await findJobByIdempotencyKey(input.idempotencyKey);
  if (!existing) {
    throw new ApiError(500, 'Job was not created and the existing job could not be found');
  }
  return { job: toApiJob(existing), duplicate: true };
}

export async function getJobById(id: string): Promise<JobApi> {
  const row = await findJobById(id);
  if (!row) {
    throw new ApiError(404, 'Job not found');
  }
  return toApiJob(row);
}