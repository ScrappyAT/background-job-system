# Background Job System

A background job system for **asynchronous AI customer-review analysis**.

A client submits customer-review text to an API. The API records the work as a **job**
and responds immediately; the AI analysis itself runs later, out of band, in a separate
worker process.

> **Phase 7 status:** `review_analysis` jobs now perform a **real DeepSeek API call**
> (OpenAI-compatible) instead of a deterministic simulation. The response is parsed and
> validated locally with Zod (incl. a verbatim-quote check) before being persisted as the
> job's durable result. Provider failures (and validation rejections) are treated like any
> other handler failure, so they flow through the existing retry/backoff/dead-letter
> lifecycle. Requires `DEEPSEEK_API_KEY` for real work; `testFailureMode` break-tests still
> fail **before** the provider call. Authentication is **not** implemented yet. See
> [Review-analysis handler (real DeepSeek API)](#review-analysis-handler-real-deepseek-api)
> and [What is intentionally NOT implemented yet](#what-is-intentionally-not-implemented-yet).

## Tech stack

- **Node.js** runtime
- **TypeScript** for type-safe development
- **Express** HTTP framework
- **PostgreSQL** persistent store
- **pg** PostgreSQL driver for Node
- **dotenv** for environment configuration
- **OpenAI SDK** (official) pointed at the **DeepSeek** API for real review analysis
- **zod** for runtime validation (payloads and AI output)

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
  makes the review-analysis handler deliberately throw **before** any real DeepSeek call so
  retry behaviour can be demonstrated without spending a provider request. Omit it for
  normal (real) behaviour. See
  [Controlled test failure mode](#controlled-test-failure-mode).
- `testProcessingDelayMs` — **optional**, an integer between `0` and `120000` inclusive.
  Overrides the artificial processing delay for this single job (used to keep a job in
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

The response also includes a `result` field: it is `null` until the worker has successfully
persisted a `job_results` row, after which it contains the durable AI analysis output
(`sentiment`, `rating`, `themes`, `complaints`, `quote`). Existing job fields are unchanged.

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
it with `testProcessingDelayMs` (bounded 0–120000). That single job's handler then
sleeps the override instead of `WORKER_TASK_DELAY_MS`; all other jobs are unaffected. For a
clean single-recovery demo keep the worker's `JOB_STUCK_TIMEOUT_MS` **larger** than the delay
(see [Test F](#test-f--crash-recovery-stuck-job-with-stale-worker-evidence)).

### Review-analysis handler (real DeepSeek API)

`review_analysis` jobs call the **DeepSeek API** (OpenAI-compatible) via the official
OpenAI SDK. The handler:

1. reads the `review` from the job payload (a non-empty string — the job schema guarantees
   this at enqueue time);
2. applies the artificial processing delay — by default `WORKER_TASK_DELAY_MS`
   (default `2500` ms), or the job's own `testProcessingDelayMs` (0–120000) when that
   optional payload field is set (for controlled crash-recovery demos);
3. runs the configured `testFailureMode` break-tests (there is **no** DeepSeek call in those
   paths — see below);
4. sends the review to `https://api.deepseek.com` with `response_format: { type: 'json_object' }`
   using `deepseek-flash` (default; override with `DEEPSEEK_MODEL`), asking the model to
   return **only** a JSON object with exactly these fields:

```json
{
  "sentiment": "positive",
  "rating": 4,
  "themes": ["battery life", "comfort"],
  "complaints": ["earbuds are uncomfortable"],
  "quote": "the battery life is great but the earbuds are uncomfortable"
}
```

5. **validates the output locally** — JSON mode is guidance, not a guarantee — with a Zod
   schema (`sentiment` ∈ positive|negative|mixed, `rating` an integer 1–5, `themes`/
   `complaints` arrays of strings, `quote` a non-empty string), and additionally checks that
   the returned `quote` appears **verbatim** in the original review text.

Any failure — missing `DEEPSEEK_API_KEY`, provider/HTTP error, empty response, invalid
JSON, failed schema validation, or a mismatched quote — **throws**, and the job flows
through the normal failure/retry/backoff/dead lifecycle exactly like any other handler
error. The client does **not** retry internally: `maxRetries: 0` in the OpenAI SDK config,
so all retry responsibility stays with the job system. The provider request (not the API
key) is bounded by `DEEPSEEK_TIMEOUT_MS` (default 60000).

The successful validated object becomes the durable `job_results.result`. Worker logs
include the model, request duration, and outcome — never the API key, Authorization header,
or the full provider response. Unknown job types are treated like any other failure: the
error is recorded and the job is retried (then eventually `dead`) via the normal retry path.

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

**Controlled test failure mode.** An optional `testFailureMode` field on `POST /api/jobs`
(only `"always"` and `"once"` are accepted; anything else is rejected with `422`) makes the
handler fail deliberately **before** the DeepSeek call, so the retry lifecycle can be
demonstrated deterministically — without a real provider request (no API key needed for
these paths):

- `testFailureMode: "always"` — every attempt throws a predictable error, so the job is
  guaranteed to burn through all attempts and end `dead`. This is what lets us prove the
  100%-failure path.
- `testFailureMode: "once"` — fails only the first attempt (`attempt === 1`) and succeeds
  on the second, proving a failed-then-recovered lifecycle. Its final `attempts` is 2; the
  second attempt performs the real DeepSeek call, so it requires `DEEPSEEK_API_KEY` to
  actually succeed.

The field is stored in the job's payload so every retry behaves consistently. Normal jobs
without the field are completely unaffected and always take the real DeepSeek path.

### Current limitations

- Stuck-job recovery runs only while a worker is alive — if **no** worker runs, nothing
  sweeps and stranded `processing` jobs stay stranded until a worker starts.
- The dead-letter page and API have **no authentication** — they are operational/debugging
  endpoints intended for local or trusted-network use.
- A manually retried job keeps its **original payload**. If that payload contained
  `testFailureMode: "always"`, the job simply fails again and returns to `dead` (expected;
  there is no payload-mutation endpoint by design).
- Real analysis requires a **`DEEPSEEK_API_KEY`** in `.env`. Without one, normal jobs fail
  with a provider error and go down the retry/backoff/dead path (never silently succeed),
  and `testFailureMode: "once"` cannot complete its second attempt.
- Only **DeepSeek** is wired as a provider; the OpenAI-SDK integration is DeepSeek-specific
  (`baseURL https://api.deepseek.com`, `deepseek-flash`).

## Dead-letter view and manual retry

### What the dead-letter view is

When a job exhausts its retry budget it becomes `dead`. The dead-letter view surfaces those
jobs so an operator can inspect exactly what failed and, after deciding it is safe, restart
the job with a fresh retry budget — without creating a duplicate and without losing the
original payload or idempotency key.

### `GET /api/jobs/dead`

Returns **only `dead` jobs**, ordered **newest/recently-dead first** (by `finished_at`
descending). Response shape:

```json
{
  "jobs": [
    {
      "id": "…",
      "type": "review_analysis",
      "payload": { "review": "…" },
      "status": "dead",
      "attempts": 5,
      "maxAttempts": 5,
      "lastError": "Simulated failure: testFailureMode=always",
      "idempotencyKey": "…",
      "createdAt": "…",
      "runAt": "…",
      "startedAt": "…",
      "finishedAt": "…"
    }
  ]
}
```

The route is registered **before** `GET /api/jobs/:id`, so the literal path `dead` is always
matched as the collection route and never falls into the `:id` parameter route (the
`:id` route also rejects non-UUID ids with `400` as a second guard).

### `POST /api/jobs/:id/retry`

Manually restarts a dead job. **Only valid when the job's current status is `dead`.**

Success (job was dead):

- `status` → `pending`, `attempts` → `0`, `run_at` → now, `started_at` → `null`,
  `finished_at` → `null`, `last_error` → `null`
- **same row / same job id**, payload kept, idempotency key kept, `max_attempts` unchanged
- the existing worker naturally picks it up again (the claim query already looks for
  `pending` jobs with `run_at <= now()`)

Errors:

- `404 Not found` — no job with that id exists
- `409 Conflict` — the job exists but is not `dead`
- `400` — the id is not a valid UUID

**Atomicity.** The transition is a single guarded statement — `UPDATE jobs SET ... WHERE
id = $1 AND status = 'dead'` (with `RETURNING`). There is no read-then-write race: the
`status = 'dead'` predicate is the whole guard, so two concurrent retries of the same job
can only succeed once (the first update wins; the second matches zero rows). If the update
matches nothing, the service then reads the row only to distinguish `404` (no such job)
from `409` (exists, not dead) — that read is diagnostic, not part of the transition.

**Why `attempts` resets to `0`.** Manual retry is a human explicitly starting a **fresh
retry budget** after inspecting a dead job. `attempts` is "how many times the job has been
claimed/started" and the retry budget is `max_attempts`; setting `attempts = 0` means the
whole budget is available again (the next claim increments it to `1`). The existing
automatic retry logic is untouched — no `run_at` backoff is involved here, only `run_at =
now()`.

### `GET /dead-jobs`

A minimal, plain HTML/CSS/JS operational page (no frontend framework). It:

- fetches and displays the dead jobs from `GET /api/jobs/dead`
- shows job id, type, payload (pretty-printed JSON), attempts/maxAttempts, last error,
  and the timestamps (created/run/started/finished)
- renders a **Retry** button per job that calls `POST /api/jobs/:id/retry`
- shows a clear success/error message and refreshes the list (the retried job disappears
  from the dead list)

It is served by the API itself from a compiled module (`src/http/deadJobsPage.ts`) — no
separate static-file pipeline or frontend build was introduced.

### `GET /demo` — demo/testing UI

A single plain HTML/CSS/JS page (same lightweight approach as `/dead-jobs`, no frontend
framework) for manually exercising the system:

- a **Customer Review** textarea and an **Idempotency Key** input with a **Generate** button
  (`crypto.randomUUID()` where supported; a key is auto-generated on page load);
- **Submit Review** calls the existing `POST /api/jobs` (same request contract; validation
  and idempotency behaviour come from the backend — resubmitting the same key reuses the
  existing job);
- a **Job Status** section driven by `GET /api/jobs/:id` showing the real status fields
  (id, status, attempts/maxAttempts, runAt, startedAt, finishedAt, lastError, etc.) with a
  colour-coded status badge (`pending`/`processing`/`succeeded`/`failed`/`dead`);
- an **AI Analysis Result** section that appears once the job is `succeeded` and the stored
  `job_results` row is available — it renders the real durable output only
  (sentiment badge, rating as `n / 5`, themes and complaints as chips, and the quote),
  never a client-side reconstruction;
- a **Refresh Status** button, plus automatic polling every 2 s while the job is
  `pending`/`processing` that stops at a terminal state (plain `setInterval`, no dependency);
- a link to the dead-letter view at `/dead-jobs`.

It exposes no server secrets: the browser only calls the two public endpoints
(`POST /api/jobs`, `GET /api/jobs/:id`).

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
| `WORKER_TASK_DELAY_MS`       | `2500`    | Baseline artificial delay (ms) before analysis; `testProcessingDelayMs` on a job overrides it. |
| `JOB_MAX_ATTEMPTS`           | `5`       | Retry budget; the job becomes `dead` when `attempts` reaches it.                    |
| `JOB_BASE_DELAY_MS`          | `1000`    | Base of the exponential retry backoff; retryDelay = base * 2^(attempt-1) + jitter.   |
| `JOB_STUCK_TIMEOUT_MS`       | `60000`   | Max age of a `processing` job before the stuck-job sweeper recovers it.            |
| `DEEPSEEK_API_KEY`           | —         | DeepSeek API key (required for real analysis). Leave blank in shared files; never commit. |
| `DEEPSEEK_MODEL`             | `deepseek-flash` | Model used for review analysis (DeepSeek's current model).                     |
| `DEEPSEEK_TIMEOUT_MS`        | `60000`   | Provider request timeout (ms); worker retries handle the rest.                     |

## Local setup

Prerequisites: Node.js 20+, npm, and a running PostgreSQL instance.

```powershell
# 1. Install dependencies
npm install

# 2. Create your local environment file
Copy-Item .env.example .env
#    ...then edit .env and set DATABASE_URL to your PostgreSQL instance
#    (and DEEPSEEK_API_KEY when you want real review analysis)

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
│   │   ├── errors.ts        # Shared ApiError type + UUID helpers
│   │   ├── deadJobsPage.ts  # Plain-HTML dead-letter view served at /dead-jobs
│   │   └── demoPage.ts      # Plain-HTML demo/testing UI served at /demo
│   ├── jobs/
│   │   ├── job.model.ts      # DB row → API response shape (+ dead-job shape)
│   │   ├── jobs.routes.ts    # POST /api/jobs, GET /api/jobs/dead, GET /api/jobs/:id, POST /api/jobs/:id/retry
│   │   ├── jobs.schema.ts    # zod validation for job creation
│   │   ├── jobs.service.ts   # enqueue, fetch, dead-list + manual-retry logic
│   │   └── jobs.repository.ts# Parameterized SQL queries against the jobs table
│   ├── config/
│   │   ├── env.ts        # Loads/validates environment config
│   │   └── database.ts   # pg connection pool built from DATABASE_URL
│   ├── worker/
│   │   ├── worker.ts                # Poll loop, stuck-job sweep, concurrency cap, graceful shutdown
│   │   ├── job.handlers.ts          # review_analysis handler (real DeepSeek call + break-test hooks)
│   │   ├── deepseek.client.ts       # OpenAI SDK → DeepSeek, JSON mode, local Zod + quote validation
│   │   ├── retry.ts                 # Exponential backoff + bounded jitter scheduling
│   │   └── jobs.worker.repository.ts# Atomic claim + stuck recovery + attempt-guarded completion/failure SQL
│   ├── db/
│   │   └── migrations/
│   │       ├── 001_create_jobs.sql   # Jobs table (checks, indexes, trigger)
│   │       ├── 002_create_job_results.sql  # Durable results (UNIQUE job_id)
│   │       └── run.ts                # Migration runner (ordered, tracked, transactional)
├── scripts/
│   └── verify-stale-guard.js  # Automated demo: a stale worker cannot complete a newer attempt
├── evidence/
│   └── *.png                  # Committed screenshots/transcripts of manual verification
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
- A **review-analysis handler** — deterministic simulation in Phase 3, and since Phase 7 a
  **real DeepSeek API call** (openai SDK, JSON object mode, local validation) with a delay
  configurable via `WORKER_TASK_DELAY_MS`.
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

### Phase 6 — dead-letter view and manual retry

- **`GET /api/jobs/dead`** — lists only `dead` jobs, newest-recently-dead first, with
  `payload`, `attempts`/`maxAttempts`, `lastError`, and timestamps. Registered before
  `GET /api/jobs/:id` so `dead` is never parsed as a job id.
- **`POST /api/jobs/:id/retry`** — atomically restarts a `dead` job: `pending`, `attempts =
  0`, `run_at = now()`, `started_at`/`finished_at`/`last_error` cleared, same id/payload/
  idempotency key, `max_attempts` unchanged. `404` when missing, `409` when not `dead`.
- **`GET /dead-jobs`** — minimal plain-HTML operational page served by the API: lists dead
  jobs, shows the failure context, and offers a per-job Retry button (calls the retry API,
  shows success/error, refreshes the list).
- **No schema, worker, retry/backoff, or claiming-logic changes** — the worker picks up a
  manually retried job through the existing `pending` + `run_at <= now()` path.

### Phase 7 — real DeepSeek review analysis

- `review_analysis` jobs now call the **DeepSeek API** through the official OpenAI SDK
  (base URL `https://api.deepseek.com`, no internal retries) instead of a deterministic
  simulation; the default model is **`deepseek-flash`** (`DEEPSEEK_MODEL`, configurable).
- The response is forced to JSON (`response_format: { type: 'json_object' }`) and then
  **validated locally with Zod** — `sentiment`, integer `rating` 1–5, `themes`/
  `complaints` string arrays, `quote` — plus a **verbatim-quote check** against the original
  review text. Any failure throws, so provider or validation errors flow through the
  existing retry/backoff/dead lifecycle; the job system alone owns retries.
- `DEEPSEEK_API_KEY` is **optional at boot** — without it, real (non-test) jobs fail with a
  clear provider error and retry/back off. `testFailureMode` break-tests still throw
  **before** any DeepSeek call, so they never need a key. The test delay
  (`testProcessingDelayMs`/`WORKER_TASK_DELAY_MS`) is preserved as a test/demo-only sleep.
- No secrets are logged or stored beyond env: logs carry model, duration, and outcome only.
- Durable results and the attempt-number ownership guard are **unchanged** — success writes
  `job_results` atomically with the guarded completion.

## What is intentionally NOT implemented yet

- Authentication, job-edit/payload-mutation endpoints (a retried job keeps its payload),
  React frontend, other AI providers (only DeepSeek is wired), Redis/BullMQ queues, Docker.

These are deliberately deferred to later phases.

## Manual verification (Tests A–I)

Prerequisites: API running (`npm start`) and worker running (`npm run worker:start`) in two
separate terminals, using the default `JOB_MAX_ATTEMPTS = 5` and `JOB_BASE_DELAY_MS = 1000`.

### Test A — normal successful job

```powershell
$body = @{ review = 'A normal review that should succeed.'; idempotencyKey = 'test-A' } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Depth 5
# With a real DEEPSEEK_API_KEY in .env: after the artificial delay the worker calls
# DeepSeek and the job succeeds (attempts=1) with the structured analysis in the result:
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# Without a key, the same job fails with the provider error and retries until it ends dead.
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

### Test H — dead-letter view + manual retry (Phase 6)

Prerequisites: API and worker running (`npm start`, `npm run worker:start`) with the
default `JOB_MAX_ATTEMPTS = 5` (so the job dies in roughly 1+2+4+8 s of backoff plus worker
delays ≈ 30 s).

**A. Create a job that will definitely die** — `testFailureMode: "always"` makes every
attempt fail until the budget is exhausted:

```powershell
$body = @{
  review          = 'Dead-letter view demo.';
  idempotencyKey  = 'dead-letter-demo';
  testFailureMode = 'always'
} | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Depth 5   # note $r.job.id (or $r.duplicate)
```

**B. Let it exhaust retries and become `dead`** — poll until `status = "dead"`:

```powershell
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# Expected end state: status="dead", attempts=5, lastError="Simulated failure: testFailureMode=always"
```

**C. Open the dead-letter view** — browse to <http://localhost:3000/dead-jobs> (or query the
API directly):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/jobs/dead | ConvertTo-Json -Depth 6
# The dead job is listed with its payload, attempts=5 / maxAttempts=5, lastError, and timestamps.
```

Confirm on the page that the payload, error, and attempts/maxAttempts are visible for that
job id.

**D. Manually retry it** (click **Retry** on the page, or call the endpoint):

```powershell
Invoke-RestMethod -Method Post -Uri ("http://localhost:3000/api/jobs/" + $r.job.id + "/retry") | ConvertTo-Json -Depth 5
```

**E. Confirm the same job is `pending` with a fresh budget:**

```powershell
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# Same id, status="pending", attempts=0, maxAttempts=5, lastError=null. The job is gone from /api/jobs/dead.
```

**F. It will fail again — expected.** The original payload (including
`testFailureMode: "always"`) is preserved, so after the worker picks it up it burns the new
budget and returns to `dead`:

```powershell
# wait ~30 s, then:
Invoke-RestMethod -Uri ("http://localhost:3000/api/jobs/" + $r.job.id) | ConvertTo-Json -Depth 5
# status="dead" again, attempts=5 — proving the payload drives the (re)behaviour.
```

**Is there a safe way to make a retried dead job succeed?** There is **no** payload-mutation
or "toggle failure" endpoint by design — a manual retry re-runs the exact original payload,
so a payload that always fails (or an environment that still causes the original failure)
will fail again. That is the intended, honest behaviour. To observe a successful post-retry
run you would retry a job whose failure cause is transient or environmental (e.g. it died
temporarily for reasons unrelated to the payload) — no extra endpoints were added for this.

### Test I — 50-job concurrency cap (break test)

Goal: flood the queue with 50 jobs **before** the worker starts, then prove the worker never
runs more than `WORKER_CONCURRENCY` jobs at once.

```powershell
# 1. Enqueue with each job budget-limited to ONE execution. The retry decision uses the
#    job's STORED max_attempts (copied from the enqueuing process's JOB_MAX_ATTEMPTS),
#    so set it on the API BEFORE submitting — the worker-side setting is irrelevant.
$env:JOB_MAX_ATTEMPTS = '1'
npm start                    # terminal 1 — API (enqueues with maxAttempts=1)

# 2. Enqueue 50 jobs (worker NOT running yet), all pending:
#    - unique idempotencyKeys
#    - testProcessingDelayMs = 2500  (keeps each job 'processing' 2.5 s so concurrency is observable)
#    - testFailureMode = 'always'    (controlled failure BEFORE the DeepSeek call = zero provider calls)
1..50 | ForEach-Object {
  $body = @{
    review                = "Fifty-job concurrency burst #$_"
    idempotencyKey        = "conc-$([DateTime]::Now.Ticks)-$_"
    testProcessingDelayMs = 2500
    testFailureMode       = 'always'
  } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/jobs -ContentType 'application/json' -Body $body | Out-Null
}

# 3. Confirm 50 pending, then start the worker with the concurrency cap under test:
$env:WORKER_CONCURRENCY = '3'
npm run worker:start       # terminal 2

# 4. Watch the worker log — expect repeated:
#    claimed job ... active=1/3
#    claimed job ... active=2/3
#    claimed job ... active=3/3
#    (and NEVER active=4/3)
```

Expected outcome: `active=N/3` with `N` never exceeding 3. Each job sleeps its 2.5 s delay,
fails locally (`testFailureMode: always` — thrown **before** the DeepSeek call), and with
`maxAttempts=1` goes straight to `dead` (attempts=1), freeing a slot for the next eligible
job. Because the forced failure short-circuits before the provider call, this break test
performs **zero DeepSeek API requests**.

## Verified Results and Evidence

The results below are what was **actually observed** during manual verification. Each entry
links the screenshot committed under `evidence/`; the screenshots are the committed
machine-generated record of the runs (worker logs, API responses, dead-letter page, database
state), while the timings and transitions below were observed live.

### 1. Database-backed idempotency

Observed:
- The same `idempotencyKey` was submitted twice.
- Both requests resolved to a **single** job (the same job `id` in both responses).
- The duplicate request did **not** create a second job or alter the original row.

Evidence:
- [View evidence — 01-idempotency](evidence/01-idempotency.png)

### 2. Retry, exponential backoff, jitter, and dead transition

Observed (forced 100% failure via `testFailureMode: always`, `JOB_MAX_ATTEMPTS=5`,
`JOB_BASE_DELAY_MS=1000`):
- Retry delays grew across attempts, observed approximately:
  - attempt 1 → 2: **1365 ms**
  - attempt 2 → 3: **2164 ms**
  - attempt 3 → 4: **4749 ms**
  - attempt 4 → 5: **8457 ms**
- `attempts` increased on each execution/claim (1 → 2 → 3 → 4 → 5).
- Retryable failures returned the job to **`pending`** with a **future `runAt`**.
- The delay increased between attempts (exponential component `JOB_BASE_DELAY_MS·2^(attempt-1)`
  plus a bounded jitter of `[0, JOB_BASE_DELAY_MS]`).
- After attempt 5 the job became **`dead`**, and **no further retry occurred** (checked after
  longer than the largest theoretical delay).

> **On jitter:** jitter is a random whole number in `[0, JOB_BASE_DELAY_MS]`, so exact
> delays vary between runs — only the exponential trend (1000, 2000, 4000, 8000 base) is
> deterministic.

Evidence:
- [View evidence — 03-backoff-retries](evidence/03-backoff-retries.png)
- [View evidence — 04-dead-job-no-further-retry](evidence/04-dead-job-no-further-retry.png)

### 3. Worker crash and stuck-job recovery

Test job observed: `136d90b9-f334-466d-95e8-7b34f12e635d`

Observed:
- Worker A claimed the job as attempt **1** (`status=processing`, `started_at` set).
- The job was `processing` when Worker A was force-killed mid-job.
- Immediately after the kill, the database still showed `status=processing`, `attempts=1`,
  `started_at` set — nothing auto-changed.
- After the configured stuck timeout, worker B's sweeper recovered the job to `pending`.
- Recovery did **NOT** increment `attempts` (still 1).
- Worker B re-claimed it as attempt **2**.
- The job ultimately completed `succeeded`, and `finishedAt` was populated.

> The job finished with `attempts=2`, not 3 — the crash consumed exactly one attempt (at claim
> time); the sweep consumed none.

Evidence:
- [View evidence — before kill](evidence/05-stuck-before-kill.png)
- [View evidence — after kill](evidence/06-stuck-after-kill.png)
- [View evidence — recovery](evidence/07-stuck-recovery.png)
- [View evidence — recovery completed](evidence/08-stuck-recovery-completed.png)

### 4. Dead-letter view and manual retry

Test job observed: `158e6a43-4dae-41da-8bcc-bb70c2cae546`

Observed:
- Forced failures (`testFailureMode: always`) exhausted the retry budget → `dead`.
- The dead-letter page (`GET /dead-jobs`) displayed the job ID, pretty-printed payload,
  attempts/maxAttempts, last error, and timestamps.
- Manual Retry reused the **same job ID** (no duplicate job was created).
- Retry reset `attempts` to **0** and returned `status` to **`pending`**.
- `lastError`, `startedAt`, and `finishedAt` were cleared.
- The idempotency key and `maxAttempts` were preserved.

Evidence:
- [View evidence — dead-letter view](evidence/09-dead-letter-view.png)
- [View evidence — manual retry reset](evidence/10-manual-retry-reset.png)

### 5. Two-worker atomic-claim test

Observed:
- Two worker processes ran simultaneously: `worker-42324` and `worker-7920`.
- 12 jobs were processed.
- Work was distributed **6/6** across the two worker IDs.
- **No job ID was claimed by both workers** (no double execution).

The implementation prevents double-claiming with a single atomic SQL statement:
`SELECT ... FOR UPDATE SKIP LOCKED` merged with the `UPDATE ... RETURNING`. Rows already
locked by another worker are **skipped**, and the `pending → processing` transition happens
in the very statement that takes the lock — so two workers can never both claim the same
eligible row. (The in-process `active` set enforces `WORKER_CONCURRENCY` per worker; the SQL
enforces exclusivity across workers.)

Evidence:
- [View evidence — worker 1](evidence/05-two-workers-worker-1.png)
- [View evidence — worker 2](evidence/06-two-workers-worker-2.png)

### 6. Stale-worker ownership guard

`npm run verify:guard` (deterministic, in-repo) performs **10 checks**:

1. attempt 1 is claimed → `processing`, `attempts=1`;
2. the stuck job is recovered by the sweeper → `pending`;
3. recovery does **not** increment attempts (still 1);
4. worker B re-claims it → `processing`, `attempts=2`;
5. stale worker A (attempt 1) **cannot** mark success;
6. stale worker A (attempt 1) **cannot** record a failure;
7. the row stays `processing`, `attempts=2` after stale attempts;
8. no `job_results` row is written by the stale worker;
9. the current worker (attempt 2) can complete the job;
10. the authoritative stored result comes from the current worker (attempt 2).

Observed result: **10/10 PASS** during final testing.

> No screenshot is committed for this test — it is a fully automated check
> (`npm run build`, then `npm run verify:guard`) whose output is the pass/fail report.

### 7. Real DeepSeek background processing (live)

Job: `e49079f8-0adb-4e46-8359-ea3a58d6f785`

Observed:
- DeepSeek was called by the **worker**, not the HTTP request handler.
- Model: `deepseek-flash`.
- Provider request duration: approximately **5199 ms**.
- The job succeeded on attempt **1**.
- Exactly **one** durable `job_results` row existed for the job.
- The structured result passed local (Zod) validation.
- The returned `quote` was verified as an exact substring of the original review.

Stored result:

```json
{
  "quote": "The earbuds are comfortable too, but the microphone sounds muffled during calls and the charging case feels a little cheap.",
  "rating": 3,
  "themes": ["sound quality", "battery life", "comfort", "microphone", "charging case"],
  "sentiment": "mixed",
  "complaints": ["microphone sounds muffled during calls", "charging case feels a little cheap"]
}
```

> No screenshot is committed for this test; the evidence is the worker log
> (`deepseek request started/succeeded`, `durationMs=5199`) plus the single durable
> `job_results` row confirmed in the database.

### 8. Fifty-job concurrency-cap test

Observed:
- 50 jobs were enqueued **before** the worker was started.
- All 50 were initially `pending`.
- The test jobs were stored with **`maxAttempts=1`** (each executes at most once).
- The worker ran with `WORKER_CONCURRENCY=3`.
- The worker log repeatedly showed `active=1/3`, `active=2/3`, `active=3/3`.
- The active count **never exceeded 3**.
- `testProcessingDelayMs=2500` kept each job in `processing` long enough for the concurrent
  count to be observable.
- `testFailureMode=always` caused a controlled local failure on every run.
- Because the forced failure happens **before** the DeepSeek call, this test made
  **zero DeepSeek API requests**.

Evidence:
- [View evidence — 50-job concurrency cap](evidence/11-50-job-concurrency-cap.png)

> An earlier, smaller-scale snapshot of the same cap behaviour is also committed:
> [04-concurrency-cap-preliminary](evidence/04-concurrency-cap-preliminary.png). It is a
> preliminary concurrency observation, not one of the eight numbered tests above.

## Requirement-to-Evidence Map

| Requirement              | Implementation                                                                                              | Verification                                    | Evidence                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Immediate 202 enqueue    | `POST /api/jobs` validates + inserts, returns HTTP 202 (`src/jobs/jobs.routes.ts`)                           | Live via every POST; Tests A–I                  | no dedicated screenshot (all POST live runs)                                    |
| Idempotency              | DB `UNIQUE(idempotency_key)` + `INSERT ... ON CONFLICT DO NOTHING`                                           | Test 1                                          | [01-idempotency](evidence/01-idempotency.png)                                   |
| Separate worker          | Independent process (`npm run worker`) polling PostgreSQL; no analysis in the API path                        | Worker logs in Tests B/F/I; live DeepSeek run   | [03-backoff-retries](evidence/03-backoff-retries.png), [11-50-job-concurrency-cap](evidence/11-50-job-concurrency-cap.png) |
| Concurrency cap          | Per-process `active` set; claims `WORKER_CONCURRENCY - active` per cycle                                      | Test 8                                          | [11-50-job-concurrency-cap](evidence/11-50-job-concurrency-cap.png) (+ [04-concurrency-cap-preliminary](evidence/04-concurrency-cap-preliminary.png)) |
| Atomic multi-worker claims | Single-statement `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE ... RETURNING`                              | Test 5 (two workers, 6/6 split, no double claim) | [05-two-workers-worker-1](evidence/05-two-workers-worker-1.png), [06-two-workers-worker-2](evidence/06-two-workers-worker-2.png) |
| Exponential backoff + jitter | `src/worker/retry.ts`: `base·2^(attempt-1)` + bounded jitter `[0, base]`                                 | Test 2 (≈1365/2164/4749/8457 ms)                 | [03-backoff-retries](evidence/03-backoff-retries.png)                           |
| Dead transition          | `recordJobFailure` → `dead` when `attempts >= max_attempts`; no further retry                                | Tests 2 and 4C                                  | [04-dead-job-no-further-retry](evidence/04-dead-job-no-further-retry.png), [09-dead-letter-view](evidence/09-dead-letter-view.png) |
| Stuck-job recovery       | Sweeper: `processing` older than `JOB_STUCK_TIMEOUT_MS` → `pending`/`dead`, atomic, attempts untouched        | Test 3 (`136d…e635d`)                            | [05-stuck-before-kill](evidence/05-stuck-before-kill.png), [06-stuck-after-kill](evidence/06-stuck-after-kill.png), [07-stuck-recovery](evidence/07-stuck-recovery.png), [08-stuck-recovery-completed](evidence/08-stuck-recovery-completed.png) |
| Crash/side-effect idempotence | Guarded success `UPDATE` + `job_results` insert in one transaction; `UNIQUE(job_id)`; stale writes blocked | Test 3 (attempts=2) + verify:guard check 8       | [08-stuck-recovery-completed](evidence/08-stuck-recovery-completed.png); `npm run verify:guard` |
| Stale-worker protection  | Completion/failure gated by `status='processing' AND attempts=$attempt`                                      | `npm run verify:guard` (10/10)                   | none committed (automated check)                                                |
| Dead-letter visibility   | `GET /api/jobs/dead` + `GET /dead-jobs` page (payload, attempts/max, error, timestamps)                       | Test 4C                                         | [09-dead-letter-view](evidence/09-dead-letter-view.png)                          |
| Manual retry             | `POST /api/jobs/:id/retry` atomic `WHERE status='dead'`; same id, fresh budget, payload/key preserved        | Test 4D/E                                       | [10-manual-retry-reset](evidence/10-manual-retry-reset.png)                      |
| Real AI processing       | Worker → DeepSeek via openai SDK (`deepseek-flash`, `maxRetries: 0`)                                         | Live test (`e490…)`, attempt 1, ≈5199 ms         | none committed (worker log + DB row)                                             |
| Structured result validation | Zod schema (`sentiment/rating/themes/complaints/quote`) + verbatim quote check                            | Live test result passed local validation         | none committed (stored result shown in Section 7 above)                          |

## Defence Notes

1. **How do two workers avoid claiming the same job?** Claiming is a single atomic SQL
   statement: `WITH candidates AS (SELECT id ... WHERE status='pending' AND run_at<=now()
   ORDER BY run_at, id LIMIT $n FOR UPDATE SKIP LOCKED) UPDATE jobs SET status='processing',
   started_at=now(), attempts=attempts+1 FROM candidates ... RETURNING ...`. The row lock and
   the `pending → processing` transition happen in the same statement, so there is no window
   in which another worker can still see the row as eligible; `SKIP LOCKED` makes a second
   worker skip rows a first worker already locked instead of blocking on them.

2. **What happens if a worker crashes after the side effect but before marking the job
   complete?** The side effect's output is only persisted by a worker that still owns the
   attempt: the guarded success `UPDATE ... WHERE status='processing' AND attempts=$attempt`
   is the ownership test, and the `job_results` insert runs in the same transaction and only
   when that update matched. If a worker crashes before completing, nothing authoritative is
   written; the stuck-job sweeper returns the job to `pending` (without incrementing
   `attempts`), a newer worker re-claims it as the next attempt and runs the work again
   (at-least-once), and the transactional write plus `UNIQUE(job_id)` guarantee at most one
   authoritative result row exists. A stale worker can never write a result for a job it no
   longer owns.

3. **Why is jitter added to exponential backoff, and where is it implemented?** Without
   jitter, many jobs failing at the same instant would retry in lockstep and hammer the
   queue/downstream systems in a "thundering herd". Jitter spreads the retries. It is
   implemented in `src/worker/retry.ts` (`computeRetryDelay`): a random whole number in
   `[0, JOB_BASE_DELAY_MS]` is added to the exponential component `JOB_BASE_DELAY_MS·2^(attempt-1)`
   (capped at `2^31-1` ms), and `run_at = now + delay`.

4. **What happens if a job remains `processing` longer than the configured stuck timeout?**
   Once per poll cycle each worker runs the sweeper, which selects `processing` rows with
   `started_at < now() - JOB_STUCK_TIMEOUT_MS`, locks them atomically
   (`FOR UPDATE SKIP LOCKED`), and transitions them in one statement: if
   `attempts < max_attempts` the job returns to `pending` (`run_at = now()`, `started_at`/
   `finished_at` cleared, `attempts` **not** incremented, `last_error` set to
   `Recovered after worker timeout`), becoming immediately eligible for re-claim; if
   `attempts >= max_attempts` the job becomes `dead` with `finished_at = now()` and cannot run
   again automatically. Caveat: the sweep runs only while at least one worker is alive.

5. **About the `failed` status.** Retryable attempt failures are **not** persisted as
   `failed` — the worker returns the job to **`pending`** with a future `run_at`, so `failed`
   never becomes a resting state. `dead` is the terminal, exhausted state. `failed` remains in
   the schema/status vocabulary (it is a CHECK-constraint value) but the current worker does
   not use it as a resting state.