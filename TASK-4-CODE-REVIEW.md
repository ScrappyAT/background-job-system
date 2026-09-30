# Task 4 — Code Review Evidence

## Overview

This task focused on reviewing production-style pull requests, testing assumptions independently, giving actionable feedback, responding to reviews on my own code, and following review findings through to resolution.

---

# 1. My Pull Request

## Background Job System — Shutdown Claim Release

PR:
https://github.com/ScrappyAT/background-job-system/pull/1

The change addressed worker shutdown behaviour so jobs that had been claimed but had not started processing would be returned safely to the queue.

During review, I received feedback around:

- preserving retry errors when releasing jobs
- verifying shutdown behaviour through the real worker path
- isolating verification tests
- scheduled jobs and `run_at`
- claim-cycle shutdown races
- documentation and environment setup

I responded to each review by either changing the implementation or explaining why I disagreed.

### Example disagreement

One review suggested that the worker could claim jobs twice during the same polling cycle.

After checking the current implementation, I found that the reviewer had interpreted removed lines in the GitHub diff as active code. The current branch contained only one `claimJobs()` call.

I explained this with the current execution path rather than changing working code. The reviewer rechecked the implementation, acknowledged the clarification, and later approved the PR.

This showed me that code review is not automatically about accepting every suggestion. A disagreement can still be productive when it is supported with evidence.

---

# 2. Peer Review — Hennit-Dave

PR:
https://github.com/Hennit-Dave/freelancemarketplace-API/pull/1

I pulled and ran the PR locally rather than reviewing only the GitHub diff.

One issue I found involved search input containing a NUL control character. The value could reach Prisma/PostgreSQL and result in a database error instead of being rejected as invalid input.

My review included:

- Should Fix
- Question
- Praise
- Request Changes

The author updated the implementation.

I pulled the new commit and tested the fix again. NUL-containing search values were rejected before reaching Prisma, while normal searches, wildcard searches and boundary cases continued working.

After verifying the correction, I approved the PR.

---

# 3. Peer Review — nmesomarose

PR:
https://github.com/nmesomarose/Flight-API/pull/1

The PR added coverage for invalid `seatsBooked` values.

Instead of testing only the examples already present in the PR, I tried values outside PostgreSQL's supported integer range.

Values such as:

- `2147483648`
- `1e21`

passed the application validation but failed later in the database path, resulting in HTTP 500 instead of a client validation error.

I raised this as a Should Fix and also suggested parameterising the invalid-value tests so individual failures would be easier to identify.

The author updated the PR by:

- adding database-range validation
- adding the upper valid boundary
- adding out-of-range cases
- converting the invalid-value tests to `it.each`

The author explicitly noted that the review exposed an additional database-range gap and changed the production validation as part of the PR.

This was one of the clearest examples of my review changing the implementation rather than only commenting on style.

---

# 4. Peer Review — Joshua

PR:
https://github.com/joshua468/ai-integration-slice/pull/1

This PR changed the application's rate limiter to make quota consumption atomic and improve proxy trust handling.

I independently tested the concurrency behaviour.

## Finding

On a fresh rate-limit bucket with:

- limit: 15
- concurrent requests: 20

multiple requests could reach the create path at the same time.

One request created the bucket while the others received a P2002 unique-constraint error.

The implementation treated losing that create race as if the quota had already been exhausted.

In a forced interleaving I reproduced:

- 1 request admitted
- 19 requests rejected
- 14 quota slots still unused

I raised this as a Should Fix and suggested retrying the guarded atomic increment after P2002.

The author agreed and changed the implementation.

## Re-verification

I pulled the updated commit and independently tested the fix.

After the change:

- 20 concurrent requests with limit 15 → exactly 15 admitted
- forced create race → exactly 15 admitted
- warm bucket at count 14 → exactly 1 admitted
- bucket at count 15 → 0 admitted
- 200 concurrent requests → never exceeded 15
- typecheck passed
- production build passed

I also verified that retry and upload intentionally use separate rate-limit buckets.

After the re-test, I approved the PR.

---

# 5. Additional Peer Review — Rahbhee

PR:
https://github.com/rahbhee/records-and-access/pull/4

I tested the records and access-control flows locally.

Cross-tenant access controls held during my tests, including attempts to retrieve or delete another tenant's records.

The main issue I identified was that record creation no longer generated an audit-log entry.

Creating a record returned HTTP 201, but the audit count remained unchanged. Deleting the same record did create an audit entry.

I raised this as a Should Fix because an audit system should preserve the creation event as well as the deletion event.

I also asked about the unauthenticated demo users endpoint exposing API keys and praised the application's idempotent self-seeding behaviour.

---

# Retrospective

## Best comment I received

The most useful review comment I received concerned preserving `last_error` when releasing an unstarted retry job during shutdown.

My original shutdown change restored the job to the queue, but the review made me consider whether restoring the queue state was enough if diagnostic information from the previous attempt was lost.

That feedback eventually led me to simplify the lifecycle further so retry errors remain available while the job is processing and are only cleared or replaced at the appropriate lifecycle point.

It was useful because it focused on data semantics, not just whether the code executed successfully.

## Best comment I gave

My strongest review comment was on Joshua's rate limiter.

The implementation correctly prevented over-admission on an existing bucket, but I tested the first-request concurrency path separately.

With 20 concurrent requests and a limit of 15, I was able to force a create race that admitted only one request while leaving 14 valid quota slots unused.

The author confirmed the issue and changed the implementation.

I then pulled the fix and tested the same race again. The updated implementation consistently admitted exactly 15 requests without exceeding the limit.

That review taught me the value of testing the boundary around a concurrency fix rather than assuming that fixing one race means every concurrency path is correct.

## Something I caught in someone else's code that I also did

One recurring lesson was that testing the normal path is not enough.

In other PRs I deliberately tested cases the implementation was not obviously designed around: database integer boundaries, control characters, cold concurrency states and malformed inputs.

I had the same issue in my own PR. My first verification focused on the expected shutdown path, but reviewers pushed me toward testing orchestration, ownership, retry state and scheduled jobs more explicitly.

The pattern was the same: the implementation can look correct when tested through its expected path while still behaving incorrectly at a boundary.

## What I would change about how I write PRs

After reading and testing several other PRs, I would make my own PR descriptions more evidence-driven.

Instead of only explaining what changed, I would include:

- the invariant the change is supposed to preserve
- the important failure case
- the exact test used to verify it
- relevant before/after behaviour
- anything intentionally left out of scope

This makes the reviewer spend less time reconstructing the author's reasoning and more time challenging it.

The biggest lesson from this task is that code review is not just reading code.

A useful review requires reproducing behaviour, testing assumptions, distinguishing real defects from suspected ones, explaining disagreements with evidence, and then verifying that a proposed fix actually resolves the original problem.