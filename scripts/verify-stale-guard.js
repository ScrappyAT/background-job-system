const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

const dotenvPath = path.join(root, '.env');
if (fs.existsSync(dotenvPath)) {
  const parsed = require('dotenv').config({ path: dotenvPath }).parsed || {};
  if (!process.env.DATABASE_URL && parsed.DATABASE_URL) {
    process.env.DATABASE_URL = parsed.DATABASE_URL;
  }
}

const { pool } = require(path.join(root, 'dist', 'config', 'database.js'));
const {
  claimJobs,
  recoverStuckJobs,
  completeJobSucceeded,
  recordJobFailure,
} = require(path.join(root, 'dist', 'worker', 'jobs.worker.repository.js'));

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
  if (!condition) failures += 1;
}

let jobId = null;

async function main() {
  const idempotencyKey = `guard-check-${Date.now()}`;
  jobId = (
    await pool.query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, idempotency_key)
       VALUES ('review_analysis', '{}', 'pending', 0, 5, now(), $1)
       RETURNING id`,
      [idempotencyKey]
    )
  ).rows[0].id;

  try {
    const [a] = await claimJobs(1);
    check(
      'attempt 1 claimed -> processing, attempts=1',
      a && a.id === jobId && a.status === 'processing' && a.attempts === 1
    );

    await pool.query(
      `UPDATE jobs SET started_at = started_at - interval '2 minutes' WHERE id = $1`,
      [jobId]
    );

    const recovered = await recoverStuckJobs(60000, 5);
    check(
      'sweeper recovered stuck job -> pending',
      recovered.length === 1 && recovered[0].status === 'pending'
    );
    check(
      'recovery did NOT increment attempts (still 1)',
      recovered.length === 1 && recovered[0].attempts === 1
    );

    const [b] = await claimJobs(1);
    check(
      'worker B re-claimed -> processing, attempts=2',
      b && b.id === jobId && b.status === 'processing' && b.attempts === 2
    );

    const staleSuccess = await completeJobSucceeded(jobId, 1, {
      from: 'stale-worker-A',
    });
    check('stale worker A (attempt=1) could NOT mark success', staleSuccess === false);

    const staleFailure = await recordJobFailure(
      jobId,
      'stale failure from A',
      1,
      5,
      0
    );
    check('stale worker A (attempt=1) could NOT record a failure', staleFailure === 'not_owned');

    const row = await pool.query(
      'SELECT status, attempts FROM jobs WHERE id = $1',
      [jobId]
    );
    check(
      'row untouched by stale worker A (still processing, attempts=2)',
      row.rows[0].status === 'processing' && row.rows[0].attempts === 2
    );

    const before = await pool.query(
      'SELECT count(*)::int AS n FROM job_results WHERE job_id = $1',
      [jobId]
    );
    check('no job_results written by stale worker A', before.rows[0].n === 0);

    const owned = await completeJobSucceeded(jobId, 2, { from: 'worker-B' });
    check('worker B (attempt=2) completed successfully', owned === true);

    const after = await pool.query(
      `SELECT result->>'from' AS origin FROM job_results WHERE job_id = $1`,
      [jobId]
    );
    check(
      'authoritative stored result came from worker B (not the stale worker A)',
      after.rows[0] && after.rows[0].origin === 'worker-B'
    );
  } finally {
    if (jobId) {
      await pool.query(`DELETE FROM jobs WHERE id = $1`, [jobId]).catch(() => undefined);
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll stale-worker ownership-guard checks passed');
}

main().catch((error) => {
  console.error('Guard verification failed with error:', error);
  process.exit(1);
});