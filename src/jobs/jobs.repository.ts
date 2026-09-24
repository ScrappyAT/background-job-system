import { pool } from '../config/database';

import { JobRow } from './job.model';

export const JOB_SELECT_COLUMNS = `
  id, type, payload, status, attempts, max_attempts, last_error,
  run_at, started_at, finished_at, idempotency_key, created_at, updated_at
`;

export interface InsertJobInput {
  idempotencyKey: string;
  review: string;
  testFailureMode?: 'always' | 'once';
  testProcessingDelayMs?: number;
  maxAttempts: number;
}

export async function insertJob(
  input: InsertJobInput
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, idempotency_key)
     VALUES ($1, $2, 'pending', 0, $3, now(), $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${JOB_SELECT_COLUMNS}`,
    [
      'review_analysis',
      JSON.stringify({
        review: input.review,
        ...(input.testFailureMode
          ? { testFailureMode: input.testFailureMode }
          : {}),
        ...(input.testProcessingDelayMs !== undefined
          ? { testProcessingDelayMs: input.testProcessingDelayMs }
          : {}),
      }),
      input.maxAttempts,
      input.idempotencyKey,
    ]
  );
  return result.rows[0] ?? null;
}

export async function findJobById(id: string): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `SELECT ${JOB_SELECT_COLUMNS} FROM jobs WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function findJobResultByJobId(
  jobId: string
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ result: Record<string, unknown> }>(
    `SELECT result FROM job_results WHERE job_id = $1`,
    [jobId]
  );
  return result.rows[0]?.result ?? null;
}

export async function findJobByIdempotencyKey(
  idempotencyKey: string
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `SELECT ${JOB_SELECT_COLUMNS} FROM jobs WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0] ?? null;
}

export async function listDeadJobs(): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    `SELECT ${JOB_SELECT_COLUMNS}
     FROM jobs
     WHERE status = 'dead'
     ORDER BY COALESCE(finished_at, updated_at) DESC, id ASC`
  );
  return result.rows;
}

export async function resetDeadJobToPending(id: string): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `UPDATE jobs
     SET status = 'pending',
         attempts = 0,
         run_at = now(),
         started_at = NULL,
         finished_at = NULL,
         last_error = NULL
     WHERE id = $1 AND status = 'dead'
     RETURNING ${JOB_SELECT_COLUMNS}`,
    [id]
  );
  return result.rows[0] ?? null;
}