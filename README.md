# Background Job System

A reliable background job processing system built with **TypeScript, Express and PostgreSQL** for running asynchronous workloads outside the HTTP request lifecycle.

The project uses AI customer-review analysis as its workload, but the main engineering focus is the job-processing infrastructure: safely accepting work, processing it concurrently, retrying failures, recovering interrupted jobs and preventing duplicate execution.

## Key Engineering Features

- Asynchronous job processing with a separate worker process
- PostgreSQL-backed persistent job queue
- Idempotent job creation using database constraints
- Concurrent job processing with configurable limits
- Safe coordination between multiple workers
- Retry handling with exponential backoff
- Maximum-attempt enforcement
- Dead-letter handling for exhausted jobs
- Stuck-job detection and recovery
- Manual retry of dead jobs
- Graceful worker shutdown and job release
- Durable job results
- Real DeepSeek integration for AI review analysis
- Zod validation of AI-generated structured output
- Verification scripts for failure and recovery scenarios

## How It Works

```text
Client
   ↓
Express API
   ↓
Create Job in PostgreSQL
   ↓
Return 202 Accepted
   ↓
Background Worker
   ↓
Claim Job
   ↓
Process Work
   ↓
Success → Store Result
   │
   └── Failure → Backoff → Retry → Dead Letter
```

The API does not perform the long-running work itself. It records the job and responds immediately.

A separate worker claims eligible jobs from PostgreSQL and processes them independently.

This separation keeps the HTTP layer responsive while allowing workloads to be retried, recovered and processed concurrently.

## Tech Stack

- TypeScript
- Node.js
- Express
- PostgreSQL
- `pg`
- Zod
- DeepSeek via the OpenAI-compatible SDK

## Why Background Jobs?

A slow operation such as an AI request should not necessarily keep an HTTP request open until the work finishes.

A synchronous implementation would look like:

```text
Client → API → AI processing → Result
```

The client remains connected while the work is being performed.

This project instead uses:

```text
Client → API → Create Job → 202 Accepted
                       ↓
                    Worker
                       ↓
                 Process Job
                       ↓
                  Store Result
```

The API accepts the work and responds immediately. Processing happens independently in the worker.

This architecture makes it possible to add retries, concurrency controls, failure recovery and operational tooling without tying those responsibilities to the HTTP request lifecycle.

## Job Lifecycle

Jobs move through a small set of persistent states.

```text
pending
   ↓
processing
   ↓
succeeded
```

When processing fails:

```text
processing
   ↓
failure
   ↓
pending + future run time
   ↓
retry
```

If the maximum number of attempts is exhausted:

```text
processing
   ↓
dead
```

Dead jobs can later be inspected and manually retried.

Because the state is persisted in PostgreSQL, restarting the API or worker does not erase queued work.

## REST API

### Create a Job

```http
POST /api/jobs
```

Example request:

```json
{
  "review": "The battery life is great but the earbuds are uncomfortable.",
  "idempotencyKey": "review-001"
}
```

The API validates the request, stores the job and returns:

```http
202 Accepted
```

The actual analysis is not performed during the request.

A typical newly created job contains information such as:

```json
{
  "duplicate": false,
  "job": {
    "type": "review_analysis",
    "status": "pending",
    "attempts": 0,
    "maxAttempts": 5,
    "lastError": null
  }
}
```

## Idempotency

Clients provide an `idempotencyKey` when creating a job.

The database enforces uniqueness on this value.

Instead of relying on:

```text
SELECT → check → INSERT
```

the system uses the database as the final authority when determining whether the logical job already exists.

This protects against a race where two requests carrying the same idempotency key arrive at approximately the same time.

Submitting the same key again returns the existing job rather than creating duplicate work.

This is especially important for background processing because HTTP clients may retry requests when they are unsure whether the original request succeeded.

## Background Worker

The worker runs independently from the API.

Its responsibilities include:

1. Finding jobs that are eligible to run
2. Safely claiming jobs
3. Processing multiple jobs concurrently
4. Executing the appropriate handler
5. Persisting successful results
6. Recording failures
7. Scheduling retries
8. Moving exhausted jobs to the dead state
9. Recovering interrupted work
10. Releasing appropriate claims during shutdown

Keeping this logic outside the API separates job execution from request handling.

## Concurrency Control

The worker can process multiple jobs at the same time while respecting a configured concurrency limit.

For example:

```text
Pending jobs: 50
Worker concurrency: 3

Worker:
├── Job A → processing
├── Job B → processing
├── Job C → processing
└── remaining jobs wait
```

When one active job finishes, another eligible job can be claimed.

The repository includes evidence from a larger batch used to verify that the concurrency cap remains enforced.

See:

```text
evidence/11-50-job-concurrency-cap.png
```

## Multiple Workers

The design also considers situations where more than one worker process is running.

Workers must coordinate when claiming jobs so that the same pending job is not independently processed by multiple workers.

This moves concurrency safety closer to the persistence layer rather than depending only on in-memory application state.

Evidence for the multi-worker scenario is included in:

```text
evidence/05-two-workers-worker-1.png
evidence/06-two-workers-worker-2.png
```

## Retry Strategy

Temporary failures should not automatically result in permanently failed work.

When a handler fails, the system can schedule another attempt using backoff rather than immediately retrying in a tight loop.

Conceptually:

```text
Attempt 1
   ↓ failure
wait
Attempt 2
   ↓ failure
wait longer
Attempt 3
```

This reduces pressure on downstream services when they are unavailable or unstable.

The job stores information about previous attempts and the most recent failure.

## Error Preservation

The `lastError` field records the most recent processing error.

This allows the system to retain useful diagnostic information while a job is waiting for another attempt.

A job being retried therefore does not lose the reason its previous attempt failed.

After a successful completion, the failure state can be cleared.

This makes job state more useful for debugging and operational visibility.

## Dead-Letter Handling

Retries must eventually stop.

Once a job reaches its maximum number of attempts, it transitions to:

```text
dead
```

A dead job is no longer automatically picked up by normal processing.

This prevents permanently failing work from retrying forever.

The system includes a dead-job view for inspecting these jobs.

Evidence:

```text
evidence/09-dead-letter-view.png
```

## Manual Retry

Dead jobs are not necessarily unrecoverable.

An operator can manually reset a dead job so that it becomes eligible for processing again.

This is useful when the original cause of failure has been corrected.

For example:

```text
Provider unavailable
      ↓
Retries exhausted
      ↓
Job becomes dead
      ↓
Provider recovers
      ↓
Operator retries job
      ↓
Job returns to processing lifecycle
```

Evidence:

```text
evidence/10-manual-retry-reset.png
```

## Stuck-Job Recovery

A worker can disappear while processing a job because of:

- a process crash
- machine restart
- forced termination
- infrastructure failure
- unexpected runtime failure

Without recovery logic, the database could permanently show:

```text
status = processing
```

even though no worker is actually processing the job.

The system detects jobs that have remained in processing beyond the expected threshold and makes a recovery decision.

Depending on the job's attempt state, it can become eligible for another attempt or eventually transition to the dead state.

Evidence includes:

```text
evidence/05-stuck-before-kill.png
evidence/06-stuck-after-kill.png
evidence/07-stuck-recovery.png
evidence/08-stuck-recovery-completed.png
```

## Graceful Shutdown

Worker shutdown is another important failure boundary.

A worker may have claimed work that has not actually started when it receives a shutdown signal.

The project includes logic and verification work around releasing appropriate unstarted claims instead of leaving them incorrectly stuck in processing.

The repository also contains verification scripts for worker shutdown and claim-release behaviour.

## AI Review Analysis

The workload used to exercise the job infrastructure is customer-review analysis.

A `review_analysis` job sends review text to DeepSeek through its OpenAI-compatible API.

The model produces structured information such as:

- sentiment
- rating
- themes
- complaints
- a quote from the source review

The result is not trusted simply because the provider returns valid JSON.

## Structured Output Validation

AI-generated data is treated as untrusted input.

The response is parsed and validated locally using Zod before it is persisted as the durable job result.

The implementation also checks that the returned quote is grounded in the original review text.

This creates a boundary between:

```text
Model output
     ↓
Parse
     ↓
Validate structure
     ↓
Validate source-grounded data
     ↓
Persist trusted result
```

If validation fails, the job follows the same failure and retry lifecycle as other processing failures.

## Failure Testing

Reliable background systems need to be tested under failure conditions, not only successful ones.

The project contains controlled failure mechanisms used to exercise scenarios such as:

- temporary failure
- repeated failure
- retry scheduling
- maximum attempts
- dead jobs
- worker termination
- stuck jobs
- multiple workers
- concurrency limits

This makes the behaviour observable without depending on random production failures.

## Evidence

The repository includes evidence from the reliability scenarios exercised during development.

Examples include:

```text
evidence/01-idempotency.png
evidence/03-backoff-retries.png
evidence/04-concurrency-cap-preliminary.png
evidence/04-dead-job-no-further-retry.png
evidence/05-stuck-before-kill.png
evidence/05-two-workers-worker-1.png
evidence/06-stuck-after-kill.png
evidence/06-two-workers-worker-2.png
evidence/07-stuck-recovery.png
evidence/08-stuck-recovery-completed.png
evidence/09-dead-letter-view.png
evidence/10-manual-retry-reset.png
evidence/11-50-job-concurrency-cap.png
```

These demonstrate behaviour such as idempotency, retries, dead-letter handling, recovery and concurrency control.

## Project Structure

```text
src/
├── config/
│   ├── database.ts
│   └── env.ts
│
├── db/
│   └── migrations/
│
├── http/
│   ├── deadJobsPage.ts
│   ├── demoPage.ts
│   └── errors.ts
│
├── jobs/
│   ├── job.model.ts
│   ├── jobs.repository.ts
│   ├── jobs.routes.ts
│   ├── jobs.schema.ts
│   └── jobs.service.ts
│
├── worker/
│   ├── deepseek.client.ts
│   ├── job.handlers.ts
│   ├── jobs.worker.repository.ts
│   ├── retry.ts
│   └── worker.ts
│
├── app.ts
└── server.ts
```

The project separates HTTP concerns, persistence, job management and worker execution instead of placing the entire workflow inside route handlers.

## Database

PostgreSQL is used as both the persistent job store and the coordination layer for job processing.

Database migrations are included under:

```text
src/db/migrations/
```

The database stores the job lifecycle independently from the worker process.

That means queued and completed work survives application restarts.

## Running Locally

Clone the repository:

```bash
git clone https://github.com/ScrappyAT/background-job-system.git
cd background-job-system
```

Install dependencies:

```bash
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Configure the required values in `.env`, including your PostgreSQL connection and DeepSeek API key where required.

Run the database migrations using the project's migration command.

Start the API and worker using the scripts defined in `package.json`.

The API and worker are separate processes and should be run independently when testing the complete asynchronous flow.

## Environment Variables

Use:

```text
.env.example
```

as the reference for required configuration.

Do not commit your real `.env` file or API credentials.

A DeepSeek API key is required when running real AI review-analysis jobs.

## Verification Scripts

The repository includes additional scripts for testing worker reliability behaviour, including:

```text
scripts/verify-shutdown-release.js
scripts/verify-stale-guard.js
scripts/verify-worker-shutdown.js
```

These were used to exercise scenarios that are difficult to verify through normal happy-path API testing.

## Design Decisions

### PostgreSQL instead of an in-memory queue

An in-memory queue would lose queued work when the process restarts.

Persisting jobs in PostgreSQL makes job state durable and allows multiple processes to coordinate through shared storage.

### Separate API and worker processes

The API is responsible for accepting and inspecting work.

The worker is responsible for executing it.

This prevents slow background operations from blocking normal HTTP requests.

### Database-backed idempotency

The uniqueness rule is enforced by PostgreSQL rather than relying solely on an application-level pre-check.

This protects against concurrent duplicate requests.

### Bounded concurrency

Unlimited concurrency can overwhelm databases, external APIs and other downstream systems.

The worker therefore processes only a controlled number of jobs at once.

### Retry with backoff

Immediate repeated retries can make an outage worse.

Backoff creates space between attempts and gives temporary failures time to recover.

### Dead-letter state

Some jobs will never succeed automatically.

Moving them into a dead state prevents endless retries while keeping the failed work available for inspection.

### Stuck-job recovery

A persistent job system must account for workers disappearing during execution.

Recovery logic prevents abandoned processing states from becoming permanent.

## What I Learned

This project changed how I think about background processing.

The difficult part is not simply moving work outside an HTTP request. The difficult part is deciding what happens when things go wrong.

Building the system required thinking about questions such as:

- What happens if the same request arrives twice?
- What happens if two workers see the same job?
- How many jobs should one worker process simultaneously?
- What happens when an external provider temporarily fails?
- When should a retry happen?
- When should retries stop?
- What happens if the worker crashes after claiming work?
- How should abandoned jobs be recovered?
- What should happen to claimed work during shutdown?
- How do we preserve enough failure information to debug the system?
- How do we validate AI-generated data before allowing the application to trust it?

The project helped me move from thinking about background jobs as simply "run this later" to thinking about them as a reliability and state-management problem.

## Project Context

This project was built as part of my **Product Design & Engineering** training.

It focuses specifically on backend reliability, asynchronous processing, failure recovery and the engineering decisions required to make background work dependable.

It also builds on my broader work across product engineering, backend APIs, PostgreSQL and AI-assisted development.

## License

This project is licensed under the MIT License.
