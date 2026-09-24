# Background Job System

A background job system for **asynchronous AI customer-review analysis**.

A client submits customer-review text to an API. The API records the work as a **job**
and responds immediately; the AI analysis itself runs later, out of band, in a separate
worker process.

> **Phase 5 status:** workers now run a **stuck-job recovery sweep**. A job left in
> `processing` by a crashed worker is detected once its `started_at` is older than
> `JOB_STUCK_TIMEOUT_MS` and recovered — returned to `pending` (attempts intact) when it
> still has retry budget, or moved to `dead` when exhausted. Completion/failure updates
> carry an **attempt-number ownership guard** so a stale worker can never complete a newer
> attempt. A controlled `testProcessingDelayMs` hook keeps a job `processing` long enough
> to demonstrate the crash/recovery lifecycle. Dead-letter view/manual retry and a real AI
> provider are **not** implemented yet. See
> [What is intentionally NOT implemented yet](#what-is-intentionally-not-implemented-yet).

## Tech stack

- **Node.js** runtime
- **TypeScript** for type-safe development
- **Express** HTTP framework
- **PostgreSQL** persistent store
- **pg** PostgreSQL driver for Node
- **dotenv** for environment configuration

Deliberately excluded for now: authentication, React, queues (BullMQ/Redis), Docker, and
any other libraries that Phase 1 does not require.

## Why background jobs instead of waiting?

**Synchronous request processing** (request/response):

```
Client ──> API ──> analyze review ──> reply with result
```

The client's request is held open until the analysis finished. The caller must wait (and
may time out) while we do slow work like an AI call.

**Background job processing**:

```
Client ──> API ──> create job ──> reply "job created" (immediately)
                 (later) Worker ──> analyze review ──> mark job succeeded/failed
```

The API records the intent as a job row and answers immediately. A worker later picks the
job up, does the slow analysis, and updates the job's status. The client can poll for the
result. This keeps the API fast and resilient, and lets multiple analyses progress
concurrently.

## REST API

All endpoints return JSON. The API only persists and inspects jobs — **it never does the
work**. A separate worker process (see [Worker (background processing)](#worker-background-processing))
claims and runs jobs. While no worker is running, submitted jobs simply stay `pending`.

### `POST /api/jobs` — enqueue a review-analysis job

Accepts a review-analysis job and returns immediately without performing any analysis.

Request body:

```json
{
  "review": "The battery life is great but the earbuds are uncomfortable.",
  "idempotencyKey": "review-001"
}
```

Validation:

- `review` — required, must be a non-empty string after trimming.
- `idempotencyKey` — required, must be a non-empty string after trimming.
- `testFailureMode` — **optional**, must be `"always"` or `"once"`. A controlled hook that
  makes the simulated handler deliberately throw so retry behaviour can be demonstrated.
  Omit it for normal behaviour. See
  [Controlled test failure mode](#controlled-test-failure-mode).
- `testProcessingDelayMs` — **optional**, an integer between `0` and `120000` inclusive.
  Overrides the simulated processing delay for this single job (used to keep a job in
  `processing` long enough to demonstrate crash recovery). Omit it to use
  `WORKER_TASK_DELAY_MS` as normal. See
  [Stuck-job recovery](#stuck-job-recovery).

Both `review` and `idempotencyKey` are trimmed before being stored. Every submitted job is
created with `type = "review_analysis"`; clients cannot choose an arbitrary job type. The
testing fields are stored inside the job's payload so that retries behave consistently.

Success response — HTTP `202 Accepted` (the job was accepted for later processing):

```json
{
  "duplicate": false,
  "job": {
    "id": "3467d3f0-a325-44aa-874d-49209a433ea0",
    "type": "review_analysis",
    "status": "pending",
    "attempts": 0,
    "maxAttempts": 5,
    "lastError": null,
    "idempotencyKey": "review-001",
    "createdAt": "2026-09-24T09:34:48.715Z",
    "runAt": "2026-09-24T09:34:48.715Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

> **Why HTTP 202?** The endpoint does not do the work — it only persists the job and
> returns. 202 (Accepted) is the status code for exactly this: the request has been
> accepted for processing later. It is not 201 (Created) because the "resource" a client
> ultimately wants (the analysis result) does not exist yet.

### Idempotency key

`idempotencyKey` guarantees the same logical submission is never enqueued twice. The
`jobs.idempotency_key` column has a database-level `UNIQUE` constraint, and the insert is
performed with `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` — so the database is
the final authority, not an application-level "select then insert" check. This stays safe
even when two requests with the same key arrive at nearly the same time.

If the key already exists:

- no second job is created;
- the **existing** job is returned unchanged (its status, attempts, `run_at`, payload, and
  timestamps are not touched);
- the response is still HTTP 202 (it represents the same previously accepted job) with
  `"duplicate": true` and the original job's `id`.

Submitting the same idempotency key twice therefore returns the same job ID both times.
Example duplicate response (note the same `id`, and `"duplicate": true`):

```json
{
  "duplicate": true,
  "job": {
    "id": "3467d3f0-a325-44aa-874d-49209a433ea0",
    "type": "review_analysis",
    "status": "pending",
    "attempts": 0,
    "maxAttempts": 5,
    "lastError": null,
    "idempotencyKey": "review-001",
    "createdAt": "2026-09-24T09:34:48.715Z",
    "runAt": "2026-09-24T09:34:48.715Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

### `GET /api/jobs/:id` — get a job's status

Returns the current state of a job by its UUID, including `runAt` — the time it was or is
next eligible to run (used to inspect a scheduled retry from the outside).

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/jobs/3467d3f0-a325-44aa-874d-49209a433ea0
```

Success response — HTTP 200:

```json
{
  "job": {
    "id": "3467d3f0-a325-44aa-874d-49209a433ea0",
    "type": "review_analysis",
    "status": "pending",
    "attempts": 0,
    "maxAttempts": 5,
    "lastError": null,
    "idempotencyKey": "review-001",
    "createdAt": "2026-09-24T09:34:48.715Z",
    "runAt": "2026-09-24T09:34:48.715Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

Errors:

- `400 Bad Request` — the `:id` is not a valid UUID.
- `404 Not Found` — the UUID is valid but no such job exists.

### Error responses

Errors use a consistent JSON shape:

```json
{
  "error": {
    "status": 422,
    "message": "Validation failed",
    "details": [
      { "field": "review", "message": "..." }
    ]
  }
}
```

| Status | When                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| `400`  | Malformed job id, or the request body is not valid JSON.                                             |
| `404`  | A valid UUID was supplied but no job with that id exists.                                            |
| `422`  | Request body failed validation (e.g. missing or blank `review` / `idempotencyKey`).                  |
| `500`  | An unexpected server or database error. The client only ever sees a generic message (never stack traces or connection details). |

## Worker (background processing)

### API process vs worker process

- **API** (`npm start`, `npm run dev`) — serves HTTP: enqueues jobs and reports their
  status. It performs no analysis itself.
- **Worker** (`npm run worker`, `npm run worker:start`) — a long-running process that polls
  the database, claims eligible jobs, runs the review-analysis handler, and records the
  outcome. The API never starts the worker automatically.

Run each in a separate terminal:

```powershell
# Terminal 1 — API
npm run dev          # or: npm run build; npm start

# Terminal 2 — worker (same project, separate console)
npm run worker       # or: npm run build; npm run worker:start
```

### How the worker finds work

Every `WORKER_POLL_INTERVAL_MS` (default `1000` ms) the worker claims up to
**`WORKER_CONCURRENCY - active`** eligible jobs and processes them concurrently. A job is
eligible when `status = 'pending' AND run_at <= now()`.

### Atomic claiming (and why it is safe)

Claiming is **one PostgreSQL statement**, not a "select then update". When the worker wants
up to N jobs it runs (simplified):

```sql
WITH candidates AS (
  SELECT id
  FROM jobs
  WHERE status = 'pending' AND run_at <= now()
  ORDER BY run_at, id
  LIMIT $N
  FOR UPDATE SKIP LOCKED          -- lock these rows, skip rows another worker locked
)
UPDATE jobs j
SET status = 'processing', started_at = now(), attempts = j.attempts + 1
FROM candidates c
WHERE j.id = c.id
RETURNING ...;                    -- hands the claimed rows back to this worker
```

Why this is safe:

- **`FOR UPDATE`** places a row lock on every selected candidate. Any other transaction
  that tries to touch those rows (including another worker's claim) must wait until the
  lock is released at commit.
- **`SKIP LOCKED`** turns that blocking behaviour into "skip": rows already locked by
  another worker are skipped, so two workers never block each other — each grabs rows the
  other has not yet locked.
- Because the `SELECT ... FOR UPDATE` and the `UPDATE` are a **single atomic statement**,
  there is no window in which another worker can see the row as `pending` and claim it
  too. The row moves from `pending` to `processing` in the same instant it is locked.
- **Why `SELECT`-then-`UPDATE` would be unsafe:** with two separate queries, both workers
  could run the `SELECT`, see the same `pending` job, and then both execute the `UPDATE`.
  Nothing stops the second `UPDATE` from succeeding, so one job could be claimed (and
  processed) twice. The single-statement lock+update removes that window entirely.

The result: two (or more) workers running at the same time never claim the same job. Each
row is claimed by exactly one worker.

### Concurrency cap

`WORKER_CONCURRENCY` limits simultaneous jobs **within a single worker process**. The worker
tracks `active` jobs in memory and only ever claims `WORKER_CONCURRENCY - active` more, so
its in-process count never exceeds the configured value. Each running worker process starts
its own in-memory counter — the cap is per process by design.

### Stuck-job recovery

**What counts as stuck.** A job may be left in `processing` forever if its worker process
dies mid-job (a crash, a hard kill, or a network partition). The system detects such jobs
by their **age**:

```
A job is stuck when  status = 'processing'
                    AND started_at < now() - JOB_STUCK_TIMEOUT_MS
```

`JOB_STUCK_TIMEOUT_MS` defaults to `60000` ms. Only `processing` rows older than the
timeout are touched — `pending`, `succeeded`, `failed`, and `dead` rows are never swept.

**The safe/atomic sweep.** Once per poll cycle each worker runs a bounded
(batched, `LIMIT = workerConcurrency`) recovery pass using the same single-statement,
`FOR UPDATE SKIP LOCKED` pattern as claiming:

```sql
WITH stuck AS (
  SELECT id
  FROM jobs
  WHERE status = 'processing'
    AND started_at < now() - ($1::int * interval '1 millisecond')
  ORDER BY started_at, id
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs j
SET status     = CASE WHEN j.attempts < j.max_attempts THEN 'pending' ELSE 'dead' END,
    last_error = CASE WHEN j.attempts < j.max_attempts
                      THEN 'Recovered after worker timeout'
                      ELSE 'Recovered after worker timeout (attempts exhausted)' END
    -- retryable: run_at = now(), started_at = NULL, finished_at = NULL
    -- exhausted:            started_at kept,    finished_at = now()
FROM stuck s
WHERE j.id = s.id
RETURNING ...;
```

The row locks, the "is it still `processing` and still older than the cutoff" check, and
the state transition happen in one atomic statement, so two workers sweeping at the same
time can never recover the same row in conflicting ways — the second sweeper simply skips
the already-locked row. The partial index `idx_jobs_stuck_processing` (`started_at` where
`status = 'processing'`) keeps the lookup cheap.

**Why recovery does not increment `attempts`.** `attempts` was already incremented when
the crashed worker *claimed* the job. The crashed execution therefore already consumed one
attempt. If the sweeper incremented again, a single crash would burn two attempts. The
sweeper leaves `attempts` untouched; the next **real** claim (when the job returns to
`pending`) increments it again.

**Retryable stuck job** (`attempts < max_attempts`): returned to `pending` with
`run_at = now()`, `started_at = NULL`, `finished_at = NULL`, and
`last_error = 'Recovered after worker timeout'`. It becomes immediately eligible for the
next claim.

**Exhausted stuck job** (`attempts >= max_attempts`): the crashed execution was the last
allowed attempt, so the job must not run again: `status = 'dead'`,
`last_error = 'Recovered after worker timeout (attempts exhausted)'`, and
`finished_at = now()`. `started_at` is kept as a diagnostic.

**Worker logs.** Recovery is logged per job, e.g.:

```
[worker-123] recovered stuck job <id> attempts=1 status=pending
[worker-123] claimed job <id> attempts=2 ...
[worker-123] finished job <id> attempt=2 status=succeeded ...
```

or, for an exhausted job:

```
[worker-123] stuck job <id> exhausted attempts=5 status=dead
```

**Attempt-number ownership guard (stale worker protection).** Completion and failure
updates are no longer only conditional on `status = 'processing'` — they must also match
the **attempt number the worker was executing**:

```sql
-- success
UPDATE jobs SET status = 'succeeded', ... WHERE id = $1 AND status = 'processing' AND attempts = $2
-- handled failure
UPDATE jobs SET status = 'pending'| 'dead', ... WHERE id = $1 AND status = 'processing' AND attempts = $2
```

Consider Worker A claiming a job as `attempts = 1`, stalling, and being recovered by the
sweeper. Worker B then claims it as `attempts = 2`. If Worker A later finishes and tries
to record success or failure, its `attempts = 1` guard no longer matches — the row is
`attempts = 2` — so its update affects **zero rows** and is ignored (logged
`stale completion ignored`). Only the worker executing the current attempt can transition
the job. This is the same single guarded statement as before, just with the attempt number
added — no distributed locking.

**Why `job_results` stays safe.** The success path runs in one transaction: first the
guarded `UPDATE ... SET status='succeeded' WHERE ... attempts = $attempt`, and **only if
that update matched a row** does it insert into `job_results`. Because the guarded
`UPDATE` is the ownership test and it holds the row lock until commit, a stale worker can
never insert the authoritative result — its update matches nothing, so it inserts nothing.
`UNIQUE(job_id)` remains as a final safety net.

**Crash/recovery lifecycle (controlled demonstration):**

```
pending
 -> processing (attempt 1)        worker claimed it, started_at set
 -> worker crashes                job stranded in processing
 -> remains processing            GET /api/jobs/:id shows processing, attempts=1
 -> timeout expires               JOB_STUCK_TIMEOUT_MS passes
 -> sweeper recovers to pending   started_at NULL, last_error "Recovered after worker timeout"
 -> processing (attempt 2)        next real claim increments attempts to 2
 -> succeeded
```

To hold a job in `processing` long enough to demonstrate this by killing a worker, submit
it with `testProcessingDelayMs` (bounded 0–120000). That single job's simulated handler then
sleeps the override instead of `WORKER_TASK_DELAY_MS`; all other jobs are unaffected. For a
clean single-recovery demo keep the worker's `JOB_STUCK_TIMEOUT_MS` **larger** than the delay
(see [Test F](#test-f--crash-recovery-stuck-job-with-stale-worker-evidence)).

### Simulated review-analysis handler

There is **no AI provider** yet. `review_analysis` jobs are handled by a deterministic
simulation that:

1. reads the `review` from the job payload;
2. sleeps to mimic real analysis work — by default `WORKER_TASK_DELAY_MS`
   (default `2500` ms ≈ 2–3 s), or the job's own `testProcessingDelayMs` (0–120000) when that
   optional payload field is set;
3. returns a result derived purely from the review text, e.g.:

```json
{
  "review": "The battery life is great but the earbuds are uncomfortable.",
  "processed": true,
  "summary": "Simulated review analysis completed",
  "reviewFingerprint": "9cf9d5a7"
}
```

`reviewFingerprint` is a deterministic hash of the review, so the same review always
produces the same result. Unknown job types are treated like any other failure: the error
is recorded and the job is retried (then eventually `dead`) via the normal retry path.

### Successful completion and durable results

On success the worker updates the job **only if it still owns the current attempt** (see
the [attempt-number ownership guard](#stuck-job-recovery)) and, in the same transaction:

1. sets the job to `succeeded`, `finished_at = now()`, and clears `last_error`;
2. writes the result to the **`job_results`** table (new migration `002`):

| Column       | Type          | Notes                                              |
| ------------ | ------------- | -------------------------------------------------- |
| `id`         | `uuid`        | Primary key (database-generated).                  |
| `job_id`     | `uuid`        | **`UNIQUE`, FK → `jobs(id)`**; one row per job.    |
| `result`     | `jsonb`       | The handler's output.                              |
| `created_at` | `timestamptz` | When the result row was created.                   |

If the guarded `UPDATE` matched a row, the `job_results` insert runs inside the same
transaction (`INSERT ... ON CONFLICT (job_id) DO NOTHING` as a final safety net). If the
worker no longer owns the attempt, the `UPDATE` matches nothing and **no** result is
written — a stale worker can never leave an output behind.

### Attempts semantics

`attempts` means **"how many times the job has been claimed/started by a worker"**. The
claim statement increments `attempts` atomically when a job is picked up, so by the time a
handler runs, `attempts` is the number of the attempt currently executing (1 for the first
claim). It is **not** incremented again on success or failure — a job that succeeds on its
second attempt records `attempts = 2`, and a job that exhausts its budget records
`attempts = max_attempts`. On failure the worker compares `attempts` against the job's
`max_attempts` to decide whether to schedule a retry (returning to `pending` with a future
`run_at`) or to move the job to `dead`.

### Failure, retries, exponential backoff, and dead-lettering

**Failure semantics.** When a handler throws, the worker records the failure safely and
only if it still owns the job — the update is guarded by both `status = 'processing'`
**and** the attempt number the worker was executing, so a stale worker can never overwrite
a job owned by a newer attempt. The decision uses `attempts` vs `max_attempts`, where
`attempts` is the number of the attempt that just failed (it was incremented at claim
time):

- **retryable** (`attempts < max_attempts`) — the job is returned to **`pending`** with a
  **future `run_at`**, `last_error` set to the failure message, and `started_at`/`finished_at`
  cleared. The existing claim query (`status = 'pending' AND run_at <= now()`) picks it up
  again later. A retryable job is **never** left resting in `failed` — `failed` conceptually
  represents a single failed attempt, and the normal resting state between attempts is
  `pending`.
- **exhausted** (`attempts >= max_attempts`) — the job is set to **`dead`**, `last_error`
  is recorded, and `finished_at = now()`. No further retry is scheduled and automatic
  processing stops.

**Exponential backoff.** Each retry waits `run_at = now + retryDelay`:

```
retryDelay = JOB_BASE_DELAY_MS * 2^(attempt - 1)  +  jitter
```

`attempt` is the number of the attempt that just failed. With `JOB_BASE_DELAY_MS = 1000`
this produces ~1 s, ~2 s, ~4 s, ~8 s, … between attempts.

**Jitter.** A random whole number in **`[0, JOB_BASE_DELAY_MS]`** is added to the
exponential component. The purpose is to stop many failing jobs from all retrying at the
same instant (avoiding "thundering herd" on the queue and downstream systems). Jitter is
bounded by one base delay, so the exponential growth remains clearly visible despite the
randomness; overflow is capped at `2^31 - 1` ms.

**Retry lifecycle:**

```
pending
  -> processing (attempt 1)
  -> pending with future run_at (exponential + jitter delay)
  -> processing (attempt 2)
  -> pending with future run_at
  -> ...
  -> dead            (when attempts reaches max_attempts)
```

**Controlled test failure mode.** Because there is no real AI provider yet, the simulated
`review_analysis` handler can be told to fail deliberately via an optional `testFailureMode`
field on `POST /api/jobs` (only `"always"` and `"once"` are accepted; anything else is
rejected with `422`):

- `testFailureMode: "always"` — every attempt throws a predictable error, so the job is
  guaranteed to burn through all attempts and end `dead`. This is what lets us prove the
  100%-failure path.
- `testFailureMode: "once"` — fails only the first attempt (`attempt === 1`) and succeeds
  on the second, proving a failed-then-recovered lifecycle. Its final `attempts` is 2.

The field is stored in the job's payload so every retry behaves consistently. Normal jobs
without the field are completely unaffected. This is a testing-only hook for demonstrating
retry behaviour; a real AI provider will replace the simulation later.

### Current limitations

- Stuck-job recovery runs only while a worker is alive — if **no** worker runs, nothing
  sweeps and stranded `processing` jobs stay stranded until a worker starts.
- No dead-letter view or manual retry — a `dead` job stays `dead` until a future phase.
- No real AI provider — analysis is simulated.

## Job record design

The `jobs` table is the single source of truth for every unit of work. The worker claims
a job, does the work, and records the outcome on the same row. Because PostgreSQL is the
store, the table is durable and queryable — no separate queue needed for this phase.

### Columns

| Column           | Type          | Required | Why it exists                                                                         |
| ---------------- | ------------- | -------- | ------------------------------------------------------------------------------------- |
| `id`             | `uuid`        | Yes      | Stable primary key; generated by PostgreSQL (`gen_random_uuid()`).                    |
| `type`           | `text`        | Yes      | Kind of work; the initial type is `review_analysis`.                                  |
| `payload`        | `jsonb`       | Yes      | The job's input, e.g. the customer-review text.                                       |
| `status`         | `text`        | Yes      | Lifecycle state; constrained to the five values below.                                |
| `attempts`       | `integer`     | Yes      | Number of times the job has been claimed/started; incremented atomically on claim.   |
| `max_attempts`   | `integer`     | Yes      | Retry budget: the job becomes `dead` once `attempts` reaches this value.              |
| `last_error`     | `text`        | No       | Error message from the most recent failed attempt, when any.                          |
| `run_at`         | `timestamptz` | Yes      | When the job becomes eligible to run; also the scheduled time of the next retry.       |
| `started_at`     | `timestamptz` | No       | Set when a worker claims the job; cleared when a retry is scheduled; used to detect stuck jobs. |
| `finished_at`    | `timestamptz` | No       | Set when the job reaches a terminal outcome (`succeeded` or `dead`).                   |
| `idempotency_key`| `text`        | Yes      | Unique per job (DB-level UNIQUE) so the same work is never enqueued twice.             |
| `created_at`     | `timestamptz` | Yes      | When the row was inserted.                                                             |
| `updated_at`     | `timestamptz` | Yes      | Touched automatically on every update to reflect state changes.                        |

### Statuses

| Status       | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `pending`    | Waiting: either fresh and eligible once `run_at` has passed, or scheduled for a retry at a future `run_at`.  |
| `processing` | Claimed by a worker and in progress.                                                                      |
| `succeeded`  | Completed successfully; result persisted.                                                                  |
| `failed`     | Conceptually an individual failed attempt — retryable failures do **not** rest here; they go back to `pending` with a future `run_at`. |
| `dead`       | Retry budget exhausted; automatic processing stops and the job awaits human intervention.                  |

### `failed` vs `dead`

These two are easy to confuse, but they mean different things:

- **`failed`** — an *individual attempt* failed. If the job still has retry budget
  (`attempts < max_attempts`), the worker immediately returns it to `pending` with a future
  `run_at`, so `failed` never becomes the resting state of a retryable job (it must be
  claimable again). The failure is captured in `last_error` either way.
- **`dead`** — the job has reached `attempts = max_attempts` and will **not** be retried
  automatically; `finished_at` is set and a human must investigate and decide what to do.

A job therefore goes `pending -> processing` repeatedly (with backoff waits in between)
until its budget is used up, at which point it becomes `dead`.

### Constraints and indexes

- CHECK constraints pin `status` to the five values above, keep `attempts >= 0`,
  `max_attempts >= 1`, and `attempts <= max_attempts`.
- `idx_jobs_eligible` (`run_at`) filters `pending` jobs with `run_at <= now()` —
  the exact lookup the worker uses to find work.
- `idx_jobs_stuck_processing` (`started_at`) filters `processing` jobs that started long
  ago and never finished — the lookup used to detect stuck jobs.
- A trigger keeps `updated_at` current on every `UPDATE`.

## Configuration

Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

| Variable                     | Default   | Purpose                                                        |
| ---------------------------- | --------- | -------------------------------------------------------------- |
| `PORT`                       | `3000`    | Port the API listens on.                                       |
| `DATABASE_URL`               | —         | PostgreSQL connection string (required).                       |
| `WORKER_CONCURRENCY`         | `3`       | Max simultaneous jobs a single worker processes.               |
| `WORKER_POLL_INTERVAL_MS`    | `1000`    | How often the worker polls for eligible jobs.                  |
| `WORKER_TASK_DELAY_MS`       | `2500`    | Simulated analysis duration (ms) used instead of a real AI call. |
| `JOB_MAX_ATTEMPTS`           | `5`       | Retry budget; the job becomes `dead` when `attempts` reaches it.                    |
| `JOB_BASE_DELAY_MS`          | `1000`    | Base of the exponential retry backoff; retryDelay = base * 2^(attempt-1) + jitter.   |
| `JOB_STUCK_TIMEOUT_MS`       | `60000`   | Max age of a `processing` job before the stuck-job sweeper recovers it.            |

## Local setup

Prerequisites: Node.js 20+, npm, and a running PostgreSQL instance.

```powershell
# 1. Install dependencies
npm install

# 2. Create your local environment file
Copy-Item .env.example .env
#    ...then edit .env and set DATABASE_URL to your PostgreSQL instance

# 3. Create the schema
npm run db:migrate

# 4. Start (production build)
npm run build
npm start

# ...or run in dev mode with watch
npm run dev
```

Verify the API is up:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health
# { status = 'ok'; service = 'background-job-system'; ... }
```

## Project structure

```
background-job-system/
├── .env.example          # Documented environment variables (no secrets)
├── .gitignore            # Ignores node_modules, dist, .env
├── package.json          # Scripts and dependencies
├── tsconfig.json         # TypeScript configuration
├── src/
│   ├── app.ts            # Express app: middleware, routes, JSON error handler
│   ├── server.ts         # Bootstraps the app, listens on PORT
│   ├── http/
│   │   └── errors.ts     # Shared ApiError type + UUID helpers
│   ├── jobs/
│   │   ├── job.model.ts      # DB row → API response shape
│   │   ├── jobs.routes.ts    # POST /api/jobs, GET /api/jobs/:id
│   │   ├── jobs.schema.ts    # zod validation for job creation
│   │   ├── jobs.service.ts   # enqueue + fetch logic (idempotency handling)
│   │   └── jobs.repository.ts# Parameterized SQL queries against the jobs table
│   ├── config/
│   │   ├── env.ts        # Loads/validates environment config
│   │   └── database.ts   # pg connection pool built from DATABASE_URL
│   ├── worker/
│   │   ├── worker.ts                # Poll loop, stuck-job sweep, concurrency cap, graceful shutdown
│   │   ├── job.handlers.ts          # Simulated review-analysis handler (deterministic)
│   │   ├── retry.ts                 # Exponential backoff + bounded jitter scheduling
│   │   └── jobs.worker.repository.ts# Atomic claim + stuck recovery + attempt-guarded completion/failure SQL
│   ├── db/
│   │   └── migrations/
│   │       ├── 001_create_jobs.sql   # Jobs table (checks, indexes, trigger)
│   │       ├── 002_create_job_results.sql  # Durable results (UNIQUE job_id)
│   │       └── run.ts                # Migration runner (ordered, tracked, transactional)
├── scripts/
│   └── verify-stale-guard.js  # Automated demo: a stale worker cannot complete a newer attempt
```

## What is implemented so far

### Phase 1 — scaffold and job record

- Node.js + TypeScript + Express + PostgreSQL (+ pg + dotenv) scaffold.
- `tsconfig.json` for a Node.js/Express TypeScript project.
- npm scripts: `dev`, `build`, `start`, `db:migrate`.
- `.env.example` documenting `PORT`, `DATABASE_URL`, and the worker/job config variables.
- `.gitignore` for `node_modules`, `dist`, `.env`.
- pg connection pool module created from `DATABASE_URL`.
- First migration creating the `jobs` table (UUID id, JSONB payload, five-status CHECK,
  attempts/max_attempts checks, UNIQUE `idempotency_key`, eligibility + stuck-process
  indexes, `updated_at` trigger).
- A migration runner that applies `.sql` files in filename order, records them in a
  `schema_migrations` table, skips already-applied ones, and wraps each migration in a
  transaction (with an advisory lock to avoid concurrent-run races).
- `GET /health` returning JSON confirming the API is running.
- `README.md` documenting the system.

### Phase 2 — job enqueue + status endpoint

- `POST /api/jobs` accepting review-analysis jobs (zod validation, no client-chosen job
  type, stored payload contains the review text).
- Race-safe idempotency via the database `UNIQUE` constraint plus
  `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, returning the existing job on a
  duplicate.
- `GET /api/jobs/:id` returning a job's status (`400` for a malformed UUID, `404` when no
  such job exists).
- Consistent JSON error responses (`400`, `404`, `422`, `500`), with a centralized error
  handler that never leaks internal details.
- Service/repository layering keeps SQL and route handlers small and uses parameterized
  queries throughout.

### Phase 3 — worker: atomic claiming, execution, and durable results

- A standalone **worker** process (`npm run worker`) with its own poll loop, an in-process
  concurrency cap (`WORKER_CONCURRENCY`), and graceful shutdown on SIGINT/SIGTERM.
- **Atomic claiming** using `SELECT ... FOR UPDATE SKIP LOCKED` merged with `UPDATE ...
  FROM` + `RETURNING` in one statement, so no job can be claimed twice even with multiple
  workers running (verified by running two workers concurrently).
- `attempts` incremented atomically at claim time.
- A **simulated review-analysis handler** (deterministic result + `reviewFingerprint`,
  delay configurable via `WORKER_TASK_DELAY_MS`).
- Migration `002_create_job_results.sql`: durable `job_results` table with `UNIQUE
  job_id`, written atomically with the job's success via `INSERT ... ON CONFLICT
  (job_id) DO NOTHING`.
- Temporary failure marks a job `failed` with `last_error` (no retries yet).

### Phase 4 — failure, retries, exponential backoff + jitter, and `dead`

- Handled failures are recorded **safely** with a `status = 'processing'` guard so a stale
  worker can never overwrite a job it no longer owns.
- **Retryable** failures return the job to `pending` with a future `run_at`,
  exponential backoff (`JOB_BASE_DELAY_MS * 2^(attempt-1)`) plus bounded jitter
  (uniform `[0, JOB_BASE_DELAY_MS]`), and `last_error` recorded.
- **Exhausted** failures (`attempts >= max_attempts`) move the job to `dead` with
  `finished_at = now()`; no further retry.
- Worker logs each failure with the attempt number, exponential component, jitter
  component, final delay, next `run_at`, and the terminal `dead` line.
- Controlled **`testFailureMode`** (`"always"` / `"once"`) on `POST /api/jobs`, validated
  with Zod and persisted in the job payload, to demonstrate retry behaviour deterministically.
- `GET /api/jobs/:id` now returns `runAt` so scheduled retry times are externally observable.

### Phase 5 — stuck-job recovery and stale-worker protection

- A **stuck-job sweeper** runs inside each worker, once per poll cycle, recovering
  `processing` jobs whose `started_at` is older than `JOB_STUCK_TIMEOUT_MS`. It uses the
  same atomic `FOR UPDATE SKIP LOCKED` single-statement pattern as claiming, so concurrent
  sweepers never recover the same row.
- **Retryable samples** return to `pending` with `run_at = now()` and `started_at`/`finished_at`
  cleared; **exhausted** samples become `dead` with `finished_at = now()`. Recovery never
  increments `attempts` — the crashed execution already consumed an attempt at claim time.
- **Attempt-number ownership guard**: success and failure updates now require
  `status = 'processing' AND attempts = <the attempt the worker was executing>`, so a stale
  worker (attempt 1) can never complete a job that has since been recovered and re-claimed
  as attempt 2.
- **`job_results` stays authoritative**: the result insert happens only when the guarded
  success `UPDATE` matched within the same transaction, so a stale worker cannot persist
  output.
- Controlled **`testProcessingDelayMs`** (0–120000) keeps one job in `processing` long
  enough to demonstrate crash/recovery.
- **`scripts/verify-stale-guard.js`** (`npm run verify:guard`) — an automated controlled
  demo that a recovered-and-reclaimed job ignores a stale worker's completion/failure.

## What is intentionally NOT implemented yet

- **Dead-letter view / manual retry** — a `dead` job stays `dead` until a future phase.
- **AI / real review-analysis integration** (analysis is still a deterministic simulation).
- Authentication, React frontend, Redis/BullMQ queues, Docker.

These are deliberately deferred to later phases.

## Manual verification (Tests A–G)

Prerequisites: API running (`npm start`) and worker running (`npm run worker:start`) in two
separate terminals, using the default `JOB_MAX_ATTEMPTS = 5` and `JOB_BASE_DELAY_MS = 1000`.

### Test A — normal successful job

```powershell
$body = @{ review = 'A normal review that should succeed.'; idempotencyKey = 'test-A' } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Depth 5
# After ~3 s, inspect until succeeded (attempts=1):
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
```

### Test B — forced 100% failure -> dead

```powershell
$body = @{
  review         = 'This job is intentionally failing for retry testing.';
  idempotencyKey = 'test-B';
  testFailureMode = 'always'
} | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Depth 5
# Repeatedly inspect until the job reaches dead:
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# With maxAttempts=5 this takes roughly 1+2+4+8 s plus worker delays (a few seconds each).
# Expected end state: status="dead", attempts=5, finishedAt set, lastError set.
```

### Test C — backoff evidence

Watch the **worker terminal**. Lines to look for (delays grow across attempts):

```
[worker-123] job <id> attempt=1 failed
[worker-123] retry scheduled delayMs=~1xxx exponentialMs=1000 jitterMs=~xxx runAt=...
[worker-123] claimed job <id> attempts=2 ...
[worker-123] job <id> attempt=2 failed
[worker-123] retry scheduled delayMs=~2xxx exponentialMs=2000 jitterMs=~xxx runAt=...
...
[worker-123] job <id> attempt=5 dead lastError="..."
```

Between checks, `GET /api/jobs/:id` exposes `attempts` and `runAt` — `runAt` should keep
moving forward by the growing delay. Expect `exponentialMs` to be ~1000, ~2000, ~4000,
~8000 while `delayMs` stays slightly above the exponential due to jitter.

### Test D — no retry after dead

After the job in Test B is `dead`:

```powershell
Start-Sleep -Seconds 12   # longer than the largest theoretical retry delay (~9 s)
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# attempts must still be 5 and status must still be "dead"
```

### Test E — fail-once behaviour (`testFailureMode: "once"`)

```powershell
$body = @{
  review          = 'Fails once, then succeeds.';
  idempotencyKey  = 'test-E';
  testFailureMode = 'once'
} | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body
Start-Sleep -Seconds 8
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# Expected: status="succeeded", attempts=2 (attempt 1 failed + rescheduled; attempt 2 succeeded)
# Worker log should show attempt=1 failed with a retry, then attempt=2 succeeded.
```

### Test F — crash recovery (stuck job) with stale-worker evidence

Goal: prove that a crashed worker's job is recovered, **not** double-counted, and re-run
with a higher attempt number — and that the stale worker cannot then complete it.

Prerequisites: `npm run build` done. API runs normally (`npm start`). The worker is started
**separately** so we can kill it precisely. The worker's stuck timeout must be **larger** than
the job's simulated delay (otherwise the worker would re-sweep its own in-flight job and the
demo would churn attempts). Use `JOB_STUCK_TIMEOUT_MS=10000` with `testProcessingDelayMs=8000`
for the worker process (override in that process only; the committed default stays 60000).
Keep the API at defaults and let the worker's env differ:

```powershell
# Terminal 1 — API (defaults, no timeout change needed):
npm start

# Terminal 2 — worker with a SHORT stuck timeout (10 s) so the test is quick:
$env:JOB_STUCK_TIMEOUT_MS = '10000'
npm run worker:start
```

> On Windows, use `$env:VAR = 'value'` (PowerShell) before starting the worker. In cmd.exe
> it would be `set VAR=value`.

**Step 1 — submit a job that stays `processing` for 8 s** (a normal job finishes in ~2.5 s,
too fast to catch), then **Screenshot A** while it is mid-flight:

```powershell
$body = @{
  review                = 'Crash recovery demo.';
  idempotencyKey        = 'crash-recovery';
  testProcessingDelayMs = 8000
} | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Depth 5   # note $r.job.id

Start-Sleep -Seconds 4

# Screenshot A — worker log shows "claimed job ... attempts=1", and GET shows:
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# Expected: status="processing", attempts=1, startedAt set
```

**Step 2 — force-kill the worker while the job is still processing** (within the 8 s delay
window; graceful Ctrl+C waits for in-flight jobs, so a hard kill is required):

```powershell
# Find the exact worker PID (matches this project's worker, not the API/node):
$wk = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*dist\worker\worker.js*' }
$wk | ForEach-Object { "Killing $($_.ProcessId): $($_.CommandLine)" }
$wk | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Or, to start the worker under your control and kill it by PID:

```powershell
$env:JOB_STUCK_TIMEOUT_MS = '10000'
$wk = Start-Process node -ArgumentList 'dist/worker/worker.js' -WorkingDirectory (Get-Location) -PassThru
Write-Host "worker PID: $($wk.Id)"
Stop-Process -Id $wk.Id -Force
```

**Screenshot B** — job is stranded in `processing`; `GET /api/jobs/:id` still shows
`status="processing"`, `attempts=1`, `startedAt` set, worker log silent (worker dead):

```powershell
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
```

**Step 3 — restart the worker and watch recovery.** The job becomes stuck once its age from
the original `started_at` passes 10 s, so within ~10 s of restart it is recovered (pending,
attempts **still 1** — not double-counted), then re-claimed (attempts=2) and completed (the
8 s delay is under the 10 s timeout, so no further re-sweeps):

```powershell
$env:JOB_STUCK_TIMEOUT_MS = '10000'
npm run worker:start
# wait ~20 s, then inspect
```

**Screenshot C** — worker log sequence:

```
[worker-...] recovered stuck job <id> attempts=1 status=pending
[worker-...] claimed job <id> attempts=2 ...
[worker-...] finished job <id> attempt=2 status=succeeded ...
```

And `GET /api/jobs/:id` shows `status="succeeded"`, `attempts=2`, a `job_result`, and
`lastError` cleared (the recovered-jump was cosmetic; `last_error` reflects completed work):

```powershell
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
```

Result review: three screenshots (A claim started, B stranded attempt 1, C recovered +
attempt 2 complete). Recovery **did not** use up an extra attempt — the job finished with
`attempts=2`, not 3.

### Test G — automated stale-worker guard (`npm run verify:guard`)

Proves a recovered-and-reclaimed job is immune to its stale worker (attempt 1) finishing or
failing it, while the current owner (attempt 2) completes normally. Build first, then run
(no server or worker needed; it talks to PostgreSQL directly through the built repository):

```powershell
npm run build
npm run verify:guard
# ALL PASS on success; exits non-zero on failure.
```

Checks in order: claim → processing/attempts=1 → backdate started_at → recover → pending
(attempts still 1) → re-claim → attempts=2 → stale `completeJobSucceeded(id, attempt=1)`
returns `false` → stale failure records `not_owned` → row still processing/attempts=2 and
no `job_results` → `completeJobSucceeded(id, attempt=2)` returns `true` → result row exists
with origin `worker-B`. The job row is cleaned up afterwards.