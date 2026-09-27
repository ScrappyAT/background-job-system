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
  releaseUnstartedClaims,
} = require(path.join(root, 'dist', 'worker', 'jobs.worker.repository.js'));

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
       VALUES ('review_analysis', '{}', 'pending', 0, 5, now() - interval '1 hour', $1)
       RETURNING id`,
      [`shutdown-release-${label}-${Date.now()}`]
    )
  ).rows[0].id;
  jobIds.push(id);
  return id;
}

async function readState(id) {
  const row = await pool.query(
    'SELECT status, attempts, started_at, run_at FROM jobs WHERE id = $1',
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
