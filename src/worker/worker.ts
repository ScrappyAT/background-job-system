import { config } from '../config/env';
import { closePool } from '../config/database';
import { JobRow } from '../jobs/job.model';

import { getHandler } from './job.handlers';
import { claimJobs, completeJobSucceeded, failJob } from './jobs.worker.repository';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WorkerProcess {
  readonly id = `worker-${process.pid}`;
  private readonly concurrency = config.workerConcurrency;
  private readonly pollIntervalMs = config.workerPollIntervalMs;
  private readonly active = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private shuttingDown = false;

  start(): void {
    console.log(
      `[${this.id}] starting (concurrency=${this.concurrency}, pollIntervalMs=${this.pollIntervalMs})`
    );
    void this.loop().catch((error) => {
      console.error(`[${this.id}] fatal poll loop error:`, error);
      void closePool().finally(() => process.exit(1));
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    console.log(
      `[${this.id}] shutdown requested; waiting for ${this.inFlight.size} in-flight job(s)`
    );
    await Promise.allSettled([...this.inFlight]);
    await closePool();
    console.log(`[${this.id}] database pool closed; shutdown complete`);
  }

  private async loop(): Promise<void> {
    console.log(`[${this.id}] poll loop started`);
    while (!this.shuttingDown) {
      const freeSlots = this.concurrency - this.active.size;
      if (freeSlots > 0) {
        try {
          const jobs = await claimJobs(freeSlots);
          for (const job of jobs) {
            if (this.shuttingDown) {
              break;
            }
            this.dispatch(job);
          }
        } catch (error) {
          console.error(`[${this.id}] claim failed:`, error);
        }
      }
      if (this.shuttingDown) {
        break;
      }
      await sleep(this.pollIntervalMs);
    }
    console.log(`[${this.id}] poll loop stopped`);
  }

  private dispatch(job: JobRow): void {
    this.active.add(job.id);
    console.log(
      `[${this.id}] claimed job ${job.id} type=${job.type} attempts=${job.attempts} ` +
        `active=${this.active.size}/${this.concurrency}`
    );

    const task = this.process(job).catch((error) => {
      console.error(`[${this.id}] job ${job.id} crashed unexpectedly:`, error);
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private async process(job: JobRow): Promise<void> {
    try {
      const handler = getHandler(job.type);
      if (!handler) {
        throw new Error(`no handler registered for job type "${job.type}"`);
      }
      const result = await handler(job.payload);
      await completeJobSucceeded(job.id, result);
      console.log(
        `[${this.id}] finished job ${job.id} status=succeeded ` +
          `active=${this.active.size - 1}/${this.concurrency}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await failJob(job.id, message);
      } catch (markError) {
        console.error(`[${this.id}] failed to mark job ${job.id} as failed:`, markError);
      }
      console.log(
        `[${this.id}] finished job ${job.id} status=failed ` +
          `active=${this.active.size - 1}/${this.concurrency} error="${message}"`
      );
    } finally {
      this.active.delete(job.id);
    }
  }
}

const worker = new WorkerProcess();
worker.start();

let shutdownPromise: Promise<void> | null = null;
function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownPromise) {
    return;
  }
  console.log(`[${worker.id}] received ${signal}`);
  shutdownPromise = worker
    .shutdown()
    .catch((error) => {
      console.error(`[${worker.id}] shutdown error:`, error);
    })
    .finally(() => process.exit(0));

  setTimeout(() => process.exit(1), 30000).unref();
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));