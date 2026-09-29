const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

const dotenvPath = path.join(root, '.env');
if (fs.existsSync(dotenvPath)) {
  const parsed = require('dotenv').config({ path: dotenvPath, quiet: true }).parsed || {};
  if (!process.env.DATABASE_URL && parsed.DATABASE_URL) {
    process.env.DATABASE_URL = parsed.DATABASE_URL;
  }
}

// The worker reads these when src/config/env.ts is first required, so they are set BEFORE
// the WorkerProcess module is loaded below. Neither value changes production defaults.
process.env.WORKER_CONCURRENCY = '2';
// The worker sweeps stuck `processing` jobs once per poll cycle. A 24h stuck timeout makes
// that sweep a guaranteed no-op, so this verification can never mutate an unrelated row.
process.env.JOB_STUCK_TIMEOUT_MS = '86400000';

const pg = require('pg');

const { pool: workerPool } = require(path.join(root, 'dist', 'config', 'database.js'));
const { claimJobs } = require(path.join(root, 'dist', 'worker', 'jobs.worker.repository.js'));
const { WorkerProcess } = require(path.join(root, 'dist', 'worker', 'worker.js'));

// Same isolation strategy as verify-shutdown-release.js: claimJobs() selects globally
// ("WHERE status='pending' AND run_at <= now() ORDER BY run_at ASC, id ASC LIMIT n") with
// no filter of any kind, and that is intentional production behaviour this script must not
// change. Every row inserted here gets a fixed historical run_at so it sorts ahead of any
// real application job.
const FLOOR_RUN_AT = '2000-01-01T00:00:00Z';
// Parked far in the future once the run is over so a stray worker cannot pick the rows up
// during the remaining assertions. Only ever applied to rows this script inserted.
const PARKED_RUN_AT = '2999-01-01T00:00:00Z';
const IDEMPOTENCY_PREFIX = 'worker-shutdown-';
const STUCK_TIMEOUT_MS = Number(process.env.JOB_STUCK_TIMEOUT_MS);
// One claim cycle must claim exactly this many jobs and dispatch none of them.
const CLAIMED_JOB_COUNT = 2;
// Distinct non-success exit code: the queue is not an isolated environment for this run.
const EXIT_QUEUE_NOT_IDLE = 2;
// Failsafe only. It bounds a hung run so the verification cannot block forever; it is never
// used to coordinate the claim/shutdown sequence (the barrier below does that).
const TIMEOUT_MS = 30000;

class QueueNotIsolated extends Error {}

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
  if (!condition) failures += 1;
}

const jobIds = [];

// Test-owned connection. WorkerProcess.shutdown() closes the application's pg pool, so all
// post-shutdown assertions read through this connection instead.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

// --- log capture -----------------------------------------------------------------------
// WorkerProcess runs in this process, so its console output is captured here and asserted on.
const captured = [];
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
console.log = (...args) => {
  captured.push({ level: 'log', text: args.map(fmt).join(' ') });
  originalLog(...args);
};
console.error = (...args) => {
  captured.push({ level: 'error', text: args.map(fmt).join(' ') });
  originalError(...args);
};
function fmt(value) {
  return typeof value === 'string' ? value : String(value);
}
function restoreConsole() {
  console.log = originalLog;
  console.error = originalError;
}
function findLine(pattern) {
  return captured.findIndex((entry) => pattern.test(entry.text));
}
function errorLines() {
  return captured.filter((entry) => entry.level === 'error').map((entry) => entry.text);
}

// --- helpers ---------------------------------------------------------------------------
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withTimeout(promise, label, ms = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)),
        ms
      );
    }),
  ]);
}

async function insertJob(label) {
  // testFailureMode: 'always' makes the handler throw before any DeepSeek call, so if this
  // job were ever dispatched the run would need no provider request and the job would carry
  // a non-null last_error -- which is exactly what the "no handler ran" assertion detects.
  const id = (
    await client.query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, idempotency_key)
       VALUES ('review_analysis', $3::jsonb, 'pending', 0, 5, $1::timestamptz, $2)
       RETURNING id`,
      [
        FLOOR_RUN_AT,
        `${IDEMPOTENCY_PREFIX}${label}-${Date.now()}-${jobIds.length}`,
        JSON.stringify({
          review: `worker shutdown orchestration verification ${label}`,
          testFailureMode: 'always',
        }),
      ]
    )
  ).rows[0].id;
  jobIds.push(id);
  return id;
}

async function readStates(ids) {
  const { rows } = await client.query(
    `SELECT id, status, attempts, started_at, finished_at, last_error, run_at
     FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [ids]
  );
  return rows;
}

async function countResults(ids) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM job_results WHERE job_id = ANY($1::uuid[])',
    [ids]
  );
  return rows[0].n;
}

// Read-only. Never deletes, reschedules, or updates unrelated application jobs.
async function assertQueueIsolated() {
  const { rows } = await client.query(
    `SELECT count(*)::int AS eligible_pending,
            count(*) FILTER (
              WHERE status = 'processing'
                AND started_at < now() - ($2::int * interval '1 millisecond')
            )::int AS sweepable_processing
     FROM jobs
     WHERE NOT (id = ANY($1::uuid[]))
       AND (status = 'pending' OR status = 'processing')`,
    [jobIds, STUCK_TIMEOUT_MS]
  );
  const { eligible_pending: pending, sweepable_processing: processing } = rows[0];
  if (pending > 0 || processing > 0) {
    throw new QueueNotIsolated(
      `${pending} unrelated pending job(s) are already eligible to be claimed and ` +
        `${processing} unrelated processing job(s) are old enough for the worker's stuck-job ` +
        `sweep. claimJobs() picks the globally oldest eligible rows with no filter for this ` +
        `script, and the sweep runs on every poll cycle, so a live or backlogged queue would ` +
        `make this worker mutate application rows. This verification reads that state only ` +
        `and changed nothing. Re-run it against an idle queue (ideally a dedicated test ` +
        `database).`
    );
  }
}

// Read-only fingerprint of every row this script does NOT own, used to prove the run neither
// added nor modified an unrelated job.
async function fingerprintUnrelatedRows() {
  const { rows } = await client.query(
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
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM jobs WHERE idempotency_key LIKE $1',
    [`${IDEMPOTENCY_PREFIX}%`]
  );
  return rows[0].n;
}

async function main() {
  await client.connect();
  const unrelatedBefore = await fingerprintUnrelatedRows();
  await assertQueueIsolated();

  // --- the deterministic synchronization barrier -----------------------------------------
  // claimCycles is registered, claimJobs has already committed, and the dispatch loop has
  // not run yet: the worker is parked at exactly the point a real shutdown has to survive.
  const claimCompleted = deferred();
  const resumeClaimCycle = deferred();
  let poolEndedWhenClaimCycleResumed = null;
  let claimCallCount = 0;

  async function claimWithBarrier(limit) {
    claimCallCount += 1;
    const claimed = await claimJobs(limit); // real claim against PostgreSQL
    claimCompleted.resolve(claimed.length);
    await resumeClaimCycle.promise; // hold the claim cycle open until the test says so
    poolEndedWhenClaimCycleResumed = workerPool.ended;
    return claimed;
  }

  let worker = null;
  let shutdownPromise = null;
  let shutdownCalls = 0;

  try {
    for (let index = 0; index < CLAIMED_JOB_COUNT; index += 1) {
      await insertJob(`job-${index}`);
    }

    // The real WorkerProcess class, with only its claim function substituted.
    worker = new WorkerProcess(claimWithBarrier);

    // Count shutdown() entries so "shutdown was actually invoked" is proven, not assumed.
    const realShutdown = worker.shutdown.bind(worker);
    worker.shutdown = () => {
      shutdownCalls += 1;
      return realShutdown();
    };

    worker.start();

    const claimedCount = await withTimeout(
      claimCompleted.promise,
      'the WorkerProcess claim cycle'
    );
    check(
      'WorkerProcess.start() ran one real claim cycle that claimed 2 jobs from PostgreSQL',
      claimCallCount === 1 && claimedCount === CLAIMED_JOB_COUNT
    );

    const parked = await readStates(jobIds);
    check(
      'while the claim cycle is held open both jobs are processing with attempts=1 (real claim)',
      parked.length === CLAIMED_JOB_COUNT &&
        parked.every((row) => row.status === 'processing' && row.attempts === 1)
    );
    check(
      'while the claim cycle is held open neither job has been dispatched (no claimed-job log)',
      jobIds.every((id) => findLine(new RegExp(`claimed job ${id}\\b`)) === -1)
    );

    // Exactly what requestShutdown() does on SIGINT/SIGTERM.
    shutdownPromise = worker.shutdown();

    check('WorkerProcess.shutdown() was actually invoked', shutdownCalls === 1);
    check(
      'shutdown did not close the application pool while a claim cycle was still in flight',
      workerPool.ended === false
    );

    // Let the claim cycle finish now that shutdown is waiting on it.
    resumeClaimCycle.resolve();

    let shutdownResolved = false;
    await withTimeout(
      shutdownPromise.then(() => {
        shutdownResolved = true;
      }),
      'WorkerProcess.shutdown()'
    );

    check(
      'WorkerProcess.shutdown() resolved without rejecting or timing out',
      shutdownResolved
    );
    check(
      'shutdown waited for the active claim cycle rather than closing the pool underneath it',
      poolEndedWhenClaimCycleResumed === false
    );
    check('the application pool is closed once shutdown completes', workerPool.ended === true);
    check('the poll loop exited instead of polling again', findLine(/poll loop stopped/) >= 0);
    check('shutdown logged its completion line', findLine(/database pool closed; shutdown complete/) >= 0);

    // --- the undispatched-release orchestration ------------------------------------------
    const releaseIndex = findLine(/released 2 unstarted claim\(s\) back to pending during shutdown/);
    const poolClosedIndex = findLine(/database pool closed; shutdown complete/);
    check(
      'the real undispatched-release orchestration was reached and released both claims',
      releaseIndex >= 0 && jobIds.every((id) => captured[releaseIndex].text.includes(id))
    );
    check(
      'the release happened before the pool closed (shutdown drained the claim cycle first)',
      releaseIndex >= 0 && releaseIndex < poolClosedIndex
    );
    check(
      'the release did not fail and fall back to stuck-job recovery',
      findLine(/failed to release \d+ unstarted claim\(s\)/) === -1 && errorLines().length === 0
    );
    check(
      'no handler ever started: the worker logged no claimed-job line for either job',
      jobIds.every((id) => findLine(new RegExp(`claimed job ${id}\\b`)) === -1)
    );

    // --- the released rows ----------------------------------------------------------------
    const after = await readStates(jobIds);
    check(
      'claimed-but-undispatched jobs returned to pending',
      after.length === CLAIMED_JOB_COUNT && after.every((row) => row.status === 'pending')
    );
    check(
      'their attempt count was restored (attempts=0, no attempt burned by work that never ran)',
      after.every((row) => row.attempts === 0)
    );
    check('started_at was cleared on both', after.every((row) => row.started_at === null));
    check('finished_at was cleared on both', after.every((row) => row.finished_at === null));
    check(
      'last_error is NULL on both, so no handler ran and no failure was recorded',
      after.every((row) => row.last_error === null)
    );
    check(
      'both are immediately claimable again (run_at <= now())',
      after.every((row) => new Date(row.run_at).getTime() <= Date.now())
    );
    check('no job_results row was written for either job', (await countResults(jobIds)) === 0);

    // Park the rows so a stray worker cannot claim them during the remaining assertions.
    await client.query(
      'UPDATE jobs SET run_at = $1::timestamptz WHERE id = ANY($2::uuid[])',
      [PARKED_RUN_AT, jobIds]
    );
  } finally {
    try {
      // Never leave a parked claim cycle blocking the drain loop on an aborted run.
      resumeClaimCycle.resolve();
      if (worker && !shutdownPromise) {
        shutdownPromise = worker.shutdown();
      }
      if (shutdownPromise) {
        await withTimeout(shutdownPromise, 'WorkerProcess.shutdown() (cleanup)', 10000).catch(
          () => undefined
        );
      }
      for (const id of jobIds) {
        await client.query('DELETE FROM jobs WHERE id = $1', [id]);
      }
      check(
        'no worker-shutdown-* verification rows left behind after cleanup',
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
    restoreConsole();
    await client.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll WorkerProcess graceful-shutdown orchestration checks passed');
}

main().catch((error) => {
  if (error instanceof QueueNotIsolated) {
    console.error(`\nSKIPPED - the jobs table is not an isolated queue for this verification.`);
    console.error(error.message);
    console.error('No rows were modified.');
    process.exit(EXIT_QUEUE_NOT_IDLE);
  }
  console.error('Worker-shutdown orchestration verification failed with error:', error);
  process.exit(1);
});
