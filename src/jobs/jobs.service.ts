import { config } from '../config/env';
import { ApiError } from '../http/errors';

import { DeadJobApi, JobApi, toApiJob, toDeadJobApi } from './job.model';
import {
  findJobById,
  findJobByIdempotencyKey,
  findJobResultByJobId,
  insertJob,
  listDeadJobs,
  resetDeadJobToPending,
} from './jobs.repository';

export interface EnqueuedJob {
  job: JobApi;
  duplicate: boolean;
}

export async function enqueueReviewJob(input: {
  review: string;
  idempotencyKey: string;
  testFailureMode?: 'always' | 'once';
  testProcessingDelayMs?: number;
}): Promise<EnqueuedJob> {
  const created = await insertJob({
    review: input.review,
    idempotencyKey: input.idempotencyKey,
    testFailureMode: input.testFailureMode,
    testProcessingDelayMs: input.testProcessingDelayMs,
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
  const result = await findJobResultByJobId(id);
  return toApiJob(row, result);
}

export async function getDeadJobs(): Promise<DeadJobApi[]> {
  const rows = await listDeadJobs();
  return rows.map(toDeadJobApi);
}

export async function retryDeadJob(id: string): Promise<JobApi> {
  const retried = await resetDeadJobToPending(id);
  if (retried) {
    return toApiJob(retried);
  }

  const existing = await findJobById(id);
  if (!existing) {
    throw new ApiError(404, 'Job not found');
  }
  throw new ApiError(409, 'Job is not dead and cannot be manually retried');
}