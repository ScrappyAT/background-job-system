import { pool } from '../config/database';
import { JobRow } from '../jobs/job.model';
import { JOB_SELECT_COLUMNS } from '../jobs/jobs.repository';

const JOB_RETURN_COLUMNS = JOB_SELECT_COLUMNS.split(',')
  .map((column) => `j.${column.trim()}`)
  .join(', ');

export async function claimJobs(limit: number): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    `
    WITH candidates AS (
      SELECT id
      FROM jobs
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at ASC, id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs j
    SET status = 'processing',
        started_at = now(),
        attempts = j.attempts + 1,
        last_error = NULL
    FROM candidates c
    WHERE j.id = c.id
    RETURNING ${JOB_RETURN_COLUMNS}
    `,
    [limit]
  );
  return result.rows;
}

export async function completeJobSucceeded(
  jobId: string,
  result: Record<string, unknown>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE jobs
       SET status = 'succeeded', finished_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'processing'`,
      [jobId]
    );
    await client.query(
      `INSERT INTO job_results (job_id, result)
       VALUES ($1, $2)
       ON CONFLICT (job_id) DO NOTHING`,
      [jobId, JSON.stringify(result)]
    );
    await client.query('COMMIT');

    if (updated.rowCount === 0) {
      console.warn(`job ${jobId} was not in 'processing'; result stored idempotently`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type FailOutcome = 'retry' | 'dead' | 'not_owned';

export async function recordJobFailure(
  jobId: string,
  message: string,
  attempts: number,
  maxAttempts: number,
  retryDelayMs: number
): Promise<FailOutcome> {
  if (attempts < maxAttempts) {
    const runAt = new Date(Date.now() + retryDelayMs);
    const updated = await pool.query(
      `UPDATE jobs
       SET status = 'pending',
           last_error = $2,
           run_at = $3,
           started_at = NULL,
           finished_at = NULL
       WHERE id = $1 AND status = 'processing'`,
      [jobId, message, runAt]
    );
    return updated.rowCount === 0 ? 'not_owned' : 'retry';
  }

  const updated = await pool.query(
    `UPDATE jobs
     SET status = 'dead', last_error = $2, finished_at = now()
     WHERE id = $1 AND status = 'processing'`,
    [jobId, message]
  );
  return updated.rowCount === 0 ? 'not_owned' : 'dead';
}