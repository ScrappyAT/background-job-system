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
  recordJobFailure,
  releaseUnstartedClaims,
} = require(path.join(root, 'dist', 'worker', 'jobs.worker.repository.js'));

// claimJobs() selects globally -- "WHERE status='pending' AND run_at <= now()
// ORDER BY run_at ASC, id ASC LIMIT n" -- with no filter of any kind, and that is
// intentional production behaviour that this script must not change. To be
// deterministic anyway, every row inserted here gets a fixed historical run_at so it
// sorts ahead of any real application job.
const FLOOR_RUN_AT = '2000-01-01T00:00:00Z';
// While a single specific row is being claimed, this script's OTHER pending rows are
// parked far in the future so they cannot be picked up instead. Only ever applied to
// rows this script inserted (jobIds) -- never to unrelated application jobs.
const PARKED_RUN_AT = '2999-01-01T00:00:00Z';
const IDEMPOTENCY_PREFIX = 'shutdown-release-';
// Distinct non-success exit code: the queue is not an isolated environment for this run.
const EXIT_QUEUE_NOT_IDLE = 2;

class QueueNotIsolated extends Error {}

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
  if (!condition) failures += 1;
}

const jobIds = [];

async function insertJob(label) {
  const id = (
    await pool.query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, idempotency_key)
       VALUES ('review_analysis', '{}', 'pending', 0, 5, $2::timestamptz, $1)
       RETURNING id`,
      [`${IDEMPOTENCY_PREFIX}${label}-${Date.now()}-${jobIds.length}`, FLOOR_RUN_AT]
    )
  ).rows[0].id;
  jobIds.push(id);
  return id;
}

async function readState(id) {
  const row = await pool.query(
    'SELECT status, attempts, started_at, run_at, last_error FROM jobs WHERE id = $1',
    [id]
  );
  return row.rows[0];
}

// Read-only. Never deletes, reschedules, or updates unrelated application jobs.
async function assertQueueIsolated() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
     FROM jobs
     WHERE status = 'pending'
       AND run_at <= now()
       AND NOT (id = ANY($1::uuid[]))`,
    [jobIds]
  );
  if (rows[0].n > 0) {
    throw new QueueNotIsolated(
      `${rows[0].n} unrelated pending job(s) are already eligible to be claimed. ` +
        `claimJobs() picks the globally oldest eligible rows with no filter for this ` +
        `script, so a live or backlogged queue would make it claim and mutate ` +
        `application rows. This verification reads that state only and changed ` +
        `nothing. Re-run it against an idle queue (ideally a dedicated test database).`
    );
  }
}

// Makes `targetId` the single earliest-eligible row so claimJobs(1) can only return it.
// Touches this script's own rows exclusively.
async function prepareSingleTargetClaim(targetId) {
  await pool.query(
    `UPDATE jobs SET run_at = $1::timestamptz
     WHERE id = ANY($2::uuid[]) AND id <> $3 AND status = 'pending'`,
    [PARKED_RUN_AT, jobIds, targetId]
  );
  await pool.query(
    `UPDATE jobs SET run_at = $1::timestamptz WHERE id = $2 AND status = 'pending'`,
    [FLOOR_RUN_AT, targetId]
  );
}

async function claimOwn(limit) {
  await assertQueueIsolated();
  const claimed = await claimJobs(limit);
  const foreign = claimed.filter((job) => !jobIds.includes(job.id));
  if (foreign.length > 0) {
    throw new Error(
      `claimJobs(${limit}) returned ${foreign.length} row(s) not created by this ` +
        `verification: ${foreign.map((job) => job.id).join(', ')}. Refusing to continue ` +
        `instead of operating on another run's jobs.`
    );
  }
  return claimed;
}

function requireClaim(claimed, id) {
  const row = claimed.find((job) => job.id === id);
  if (!row) {
    throw new Error(
      `claimJobs() did not return this verification's job ${id}, so the dependent check ` +
        `cannot run. Returned: ${claimed.map((job) => job.id).join(', ') || 'nothing'}. ` +
        `Another process is probably claiming rows concurrently -- re-run on an idle queue.`
    );
  }
  return row;
}

// Read-only fingerprint of every row this script does NOT own, used to prove the run
// neither added nor modified an unrelated job.
async function fingerprintUnrelatedRows() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n,
            coalesce(md5(coalesce(string_agg(
               id::text || '|' || status || '|' || attempts || '|' ||
               coalesce(last_error, '') || '|' || run_at::text || '|' || updated_at::text,
               ',' ORDER BY id), '')), '') AS digest
     FROM jobs
     WHERE NOT (id = ANY($1::uuid[]))`,
    [jobIds]
  );
  return `${rows[0].n}:${rows[0].digest}`;
}

async function countResidue() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE idempotency_key LIKE $1`,
    [`${IDEMPOTENCY_PREFIX}%`]
  );
  return rows[0].n;
}

async function main() {
  const unrelatedBefore = await fingerprintUnrelatedRows();
  await assertQueueIsolated();

  try {
    const releasedId = await insertJob('released');
    const untouchedId = await insertJob('untouched');

    const claimed = await claimOwn(2);
    const releasedClaim = requireClaim(claimed, releasedId);
    check(
      'claimed job -> processing, attempts=1',
      releasedClaim.status === 'processing' && releasedClaim.attempts === 1
    );
    check('second job claimed as well (control)', claimed.some((job) => job.id === untouchedId));

    const releasedRows = await releaseUnstartedClaims([
      { id: releasedId, attempt: releasedClaim.attempts },
    ]);
    check('release with the correct attempt released exactly 1 row', releasedRows === 1);

    const releasedState = await readState(releasedId);
    check(
      'released job -> pending, attempts=0, started_at=NULL',
      releasedState.status === 'pending' &&
        releasedState.attempts === 0 &&
        releasedState.started_at === null
    );
    check(
      'released job is immediately claimable again (run_at <= now())',
      new Date(releasedState.run_at).getTime() <= Date.now()
    );

    const untouchedState = await readState(untouchedId);
    check(
      'job not passed to the release was left alone (processing, attempts=1)',
      untouchedState.status === 'processing' && untouchedState.attempts === 1
    );

    await prepareSingleTargetClaim(releasedId);
    const reclaimed = requireClaim(await claimOwn(1), releasedId);
    check(
      're-claimed released job -> processing, attempts=1',
      reclaimed.status === 'processing' && reclaimed.attempts === 1
    );

    const staleRows = await releaseUnstartedClaims([
      { id: releasedId, attempt: reclaimed.attempts + 1 },
    ]);
    check('release with a wrong attempt released 0 rows', staleRows === 0);

    const afterStale = await readState(releasedId);
    check(
      'wrong-attempt release did not overwrite the current state (processing, attempts=1)',
      afterStale.status === 'processing' && afterStale.attempts === 1
    );

    const notProcessingRows = await releaseUnstartedClaims([
      { id: untouchedId, attempt: 1 },
    ]);
    check('control job released with its own attempt (1 row)', notProcessingRows === 1);

    const repeatRows = await releaseUnstartedClaims([{ id: untouchedId, attempt: 1 }]);
    check('releasing an already-released job affected 0 rows', repeatRows === 0);

    const finalState = await readState(untouchedId);
    check(
      'attempts never go negative after a second release (pending, attempts=0)',
      finalState.status === 'pending' && finalState.attempts === 0
    );

    console.log('\n-- last_error restoration on an unstarted release --');

    const priorFailure = 'DeepSeek timeout after 60000ms';
    const retryId = await insertJob('previous-error');

    await prepareSingleTargetClaim(retryId);
    const attempt1 = requireClaim(await claimOwn(1), retryId);
    check(
      'retry scenario: attempt 1 claimed (processing, attempts=1)',
      attempt1.status === 'processing' && attempt1.attempts === 1
    );
    check(
      'fresh job reported no previous error to restore (previous_last_error=NULL)',
      attempt1.previous_last_error === null
    );

    const failureOutcome = await recordJobFailure(retryId, priorFailure, 1, 5, 0);
    check(
      'retry scenario: the attempt failure was recorded (outcome=retry)',
      failureOutcome === 'retry'
    );

    const afterFailure = await readState(retryId);
    check(
      'retry scenario: failed job -> pending, attempts=1, last_error recorded',
      afterFailure.status === 'pending' &&
        afterFailure.attempts === 1 &&
        afterFailure.last_error === priorFailure
    );

    await prepareSingleTargetClaim(retryId);
    const attempt2 = requireClaim(await claimOwn(1), retryId);
    check(
      'retry scenario: re-claimed -> processing, attempts=2',
      attempt2.status === 'processing' && attempt2.attempts === 2
    );
    check(
      'claim cleared last_error on the processing row (last_error=NULL)',
      attempt2.last_error === null
    );
    check(
      'claim returned the pre-claim error for restoration (previous_last_error)',
      attempt2.previous_last_error === priorFailure
    );

    const staleErrorRows = await releaseUnstartedClaims([
      {
        id: retryId,
        attempt: attempt2.attempts + 1,
        previousLastError: 'stale worker must never write this',
      },
    ]);
    check('retry scenario: a stale attempt released 0 rows', staleErrorRows === 0);

    const afterStaleError = await readState(retryId);
    check(
      'retry scenario: a stale attempt left last_error and state untouched (processing, attempts=2, last_error=NULL)',
      afterStaleError.status === 'processing' &&
        afterStaleError.attempts === 2 &&
        afterStaleError.last_error === null
    );

    const restoredRows = await releaseUnstartedClaims([
      {
        id: retryId,
        attempt: attempt2.attempts,
        previousLastError: attempt2.previous_last_error,
      },
    ]);
    check('retry scenario: releasing the exact claimed attempt released 1 row', restoredRows === 1);

    const restoredState = await readState(retryId);
    check(
      'retry scenario: released job -> pending, attempts=1, previous last_error restored',
      restoredState.status === 'pending' &&
        restoredState.attempts === 1 &&
        restoredState.last_error === priorFailure
    );
    check(
      'retry scenario: restored job is claimable again (run_at <= now())',
      new Date(restoredState.run_at).getTime() <= Date.now()
    );

    const freshId = await insertJob('no-previous-error');
    await prepareSingleTargetClaim(freshId);
    const freshClaim = requireClaim(await claimOwn(1), freshId);
    check(
      'fresh job claimed -> processing, attempts=1, previous_last_error=NULL',
      freshClaim.status === 'processing' &&
        freshClaim.attempts === 1 &&
        freshClaim.previous_last_error === null
    );

    const freshRows = await releaseUnstartedClaims([
      {
        id: freshId,
        attempt: freshClaim.attempts,
        previousLastError: freshClaim.previous_last_error,
      },
    ]);
    check('fresh job released 1 row', freshRows === 1);

    const freshState = await readState(freshId);
    check(
      'fresh job with no previous failure -> pending, attempts=0, last_error=NULL',
      freshState.status === 'pending' &&
        freshState.attempts === 0 &&
        freshState.last_error === null
    );

    const omittedRows = await releaseUnstartedClaims([{ id: freshId, attempt: 1 }]);
    check(
      'omitting previousLastError cannot resurrect an error (0 rows, last_error stays NULL)',
      omittedRows === 0 && (await readState(freshId)).last_error === null
    );
  } finally {
    try {
      for (const id of jobIds) {
        await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
      }
      check(
        'no shutdown-release-* verification rows left behind after cleanup',
        (await countResidue()) === 0
      );
      check(
        'unrelated job rows were neither added nor modified by this verification',
        (await fingerprintUnrelatedRows()) === unrelatedBefore
      );
    } catch (cleanupError) {
      console.error('Cleanup failed:', cleanupError);
      process.exit(1);
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll graceful-shutdown claim-release checks passed');
}

main().catch((error) => {
  if (error instanceof QueueNotIsolated) {
    console.error(`\nSKIPPED - the jobs table is not an isolated queue for this verification.`);
    console.error(error.message);
    console.error('No rows were modified.');
    process.exit(EXIT_QUEUE_NOT_IDLE);
  }
  console.error('Shutdown-release verification failed with error:', error);
  process.exit(1);
});
