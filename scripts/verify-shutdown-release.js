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

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
  if (!condition) failures += 1;
}

const jobIds = [];

async function insertJob(label, backInterval = '1 hour') {
  const id = (
    await pool.query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, idempotency_key)
       VALUES ('review_analysis', '{}', 'pending', 0, 5, now() - $2::interval, $1)
       RETURNING id`,
      [`shutdown-release-${label}-${Date.now()}`, backInterval]
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

async function main() {
  const releasedId = await insertJob('released');
  const untouchedId = await insertJob('untouched');

  const claimed = await claimJobs(2);
  const releasedClaim = claimed.find((job) => job.id === releasedId);
  check(
    'claimed job -> processing, attempts=1',
    releasedClaim &&
      releasedClaim.status === 'processing' &&
      releasedClaim.attempts === 1
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

  const reclaimed = (await claimJobs(2)).find((job) => job.id === releasedId);
  check(
    're-claimed released job -> processing, attempts=1',
    reclaimed &&
      reclaimed.status === 'processing' &&
      reclaimed.attempts === 1
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
  const retryId = await insertJob('previous-error', '1 day');

  const attempt1 = (await claimJobs(5)).find((job) => job.id === retryId);
  check(
    'retry scenario: attempt 1 claimed (processing, attempts=1)',
    !!attempt1 && attempt1.status === 'processing' && attempt1.attempts === 1
  );
  check(
    'fresh job reported no previous error to restore (previous_last_error=NULL)',
    !!attempt1 && attempt1.previous_last_error === null
  );

  const failureOutcome = await recordJobFailure(retryId, priorFailure, 1, 5, 0);
  check('retry scenario: the attempt failure was recorded (outcome=retry)', failureOutcome === 'retry');

  const afterFailure = await readState(retryId);
  check(
    'retry scenario: failed job -> pending, attempts=1, last_error recorded',
    afterFailure.status === 'pending' &&
      afterFailure.attempts === 1 &&
      afterFailure.last_error === priorFailure
  );

  const attempt2 = (await claimJobs(5)).find((job) => job.id === retryId);
  check(
    'retry scenario: re-claimed -> processing, attempts=2',
    !!attempt2 && attempt2.status === 'processing' && attempt2.attempts === 2
  );
  check(
    'claim cleared last_error on the processing row (last_error=NULL)',
    !!attempt2 && attempt2.last_error === null
  );
  check(
    'claim returned the pre-claim error for restoration (previous_last_error)',
    !!attempt2 && attempt2.previous_last_error === priorFailure
  );

  const staleErrorRows = await releaseUnstartedClaims([
    {
      id: retryId,
      attempt: (attempt2 ? attempt2.attempts : 0) + 1,
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

  const freshId = await insertJob('no-previous-error', '1 day');
  const freshClaim = (await claimJobs(5)).find((job) => job.id === freshId);
  check(
    'fresh job claimed -> processing, attempts=1, previous_last_error=NULL',
    !!freshClaim &&
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

  try {
    for (const id of jobIds) {
      await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
    }
    await pool.end();
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll graceful-shutdown claim-release checks passed');
}

main().catch((error) => {
  console.error('Shutdown-release verification failed with error:', error);
  process.exit(1);
});
