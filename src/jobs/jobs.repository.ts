import { pool } from '../config/database';

import { JobRow } from './job.model';

export const JOB_SELECT_COLUMNS = `
  id, type, payload, status, attempts, max_attempts, last_error,
  run_at, started_at, finished_at, idempotency_key, created_at, updated_at
`;

export interface InsertJobInput {
  idempotencyKey: string;
  review: string;
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
      JSON.stringify({ review: input.review }),
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

export async function findJobByIdempotencyKey(
  idempotencyKey: string
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `SELECT ${JOB_SELECT_COLUMNS} FROM jobs WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0] ?? null;
}