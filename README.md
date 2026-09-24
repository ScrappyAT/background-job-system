# Background Job System

A background job system for **asynchronous AI customer-review analysis**.

A client submits customer-review text to an API. The API records the work as a **job**
and responds immediately; the AI analysis itself runs later, out of band, in a separate
worker process.

> **Phase 2 status:** jobs can now be enqueued (`POST /api/jobs`) and their status retrieved
> (`GET /api/jobs/:id`). There is **no background worker yet**, so enqueued jobs remain
> `pending` until a later phase. See [What is intentionally NOT implemented yet](#what-is-intentionally-not-implemented-yet).

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

All endpoints return JSON. The API endpoints documented here are the HTTP side of the job
system; **no worker exists yet**, so jobs stay in `pending` until a later phase.

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

Both values are trimmed before being stored. Every submitted job is created with
`type = "review_analysis"`; clients cannot choose an arbitrary job type.

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
    "startedAt": null,
    "finishedAt": null
  }
}
```

### `GET /api/jobs/:id` — get a job's status

Returns the current state of a job by its UUID.

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
| `attempts`       | `integer`     | Yes      | How many times the job has been attempted; starts at 0.                               |
| `max_attempts`   | `integer`     | Yes      | Cap on attempts, copied from configuration when the job is created.                   |
| `last_error`     | `text`        | No       | Error message from the most recent failed attempt, when any.                          |
| `run_at`         | `timestamptz` | Yes      | When the job becomes eligible to run; supports delayed runs and retry backoff.         |
| `started_at`     | `timestamptz` | No       | Set when a worker claims the job; used to detect stuck jobs.                           |
| `finished_at`    | `timestamptz` | No       | Set when the job reaches a terminal state (`succeeded`/`failed`/`dead`).               |
| `idempotency_key`| `text`        | Yes      | Unique per job (DB-level UNIQUE) so the same work is never enqueued twice.             |
| `created_at`     | `timestamptz` | Yes      | When the row was inserted.                                                             |
| `updated_at`     | `timestamptz` | Yes      | Touched automatically on every update to reflect state changes.                        |

### Statuses

| Status       | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `pending`    | Created and eligible to be picked up once `run_at` has passed.                                             |
| `processing` | Claimed by a worker and in progress.                                                                      |
| `succeeded`  | Completed successfully.                                                                                   |
| `failed`     | The most recent attempt failed, but the job is still allowed to retry.                                     |
| `dead`       | Attempts exhausted; the job will not run again and requires human intervention.                            |

### `failed` vs `dead`

These two are easy to confuse, but they mean different things:

- **`failed`** — an *attempt* failed, but the job has attempts left and may be retried later.
- **`dead`** — the job has exhausted `max_attempts` and will **not** be retried automatically;
  a human must investigate and decide what to do.

A job typically goes `failed` a few times and becomes `dead` only after it has used up its
last allowed attempt.

### Constraints and indexes

- CHECK constraints pin `status` to the five values above, keep `attempts >= 0`,
  `max_attempts >= 1`, and `attempts <= max_attempts`.
- `idx_jobs_eligible` (`run_at`) filters `pending` jobs with `run_at <= now()` —
  the exact lookup the worker will use to find work.
- `idx_jobs_stuck_processing` (`started_at`) filters `processing` jobs that started long
  ago and never finished — the lookup used to detect stuck jobs.
- A trigger keeps `updated_at` current on every `UPDATE`.

## Configuration

Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

| Variable                     | Default   | Purpose                                                    |
| ---------------------------- | --------- | ---------------------------------------------------------- |
| `PORT`                       | `3000`    | Port the API listens on.                                   |
| `DATABASE_URL`               | —         | PostgreSQL connection string (required).                   |
| `WORKER_CONCURRENCY`         | `3`       | Jobs the future worker processes concurrently.             |
| `JOB_MAX_ATTEMPTS`           | `5`       | Attempts before a job becomes `dead`.                      |
| `JOB_BASE_DELAY_MS`          | `1000`    | Base retry-backoff delay; later scaled by attempt number.  |
| `JOB_STUCK_TIMEOUT_MS`       | `60000`   | When a `processing` job is considered stuck.               |
| `WORKER_POLL_INTERVAL_MS`    | `1000`    | How often the future worker polls for eligible jobs.       |

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
│   └── db/
│       └── migrations/
│           ├── 001_create_jobs.sql   # Jobs table (checks, indexes, trigger)
│           └── run.ts                # Migration runner (ordered, tracked, transactional)
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

## What is intentionally NOT implemented yet

- The **background worker** (claiming, executing, and finishing jobs). Until it exists,
  enqueued jobs remain `pending`.
- Job **retries**, **backoff scheduling**, and **dead-letter** handling to `dead`.
- **AI / review-analysis integration** (any work the job actually performs).
- Authentication, React frontend, Redis/BullMQ queues, Docker.

These are deliberately deferred to later phases.