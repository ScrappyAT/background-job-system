import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function requiredFromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export const config = {
  port: intFromEnv('PORT', 3000),
  databaseUrl: requiredFromEnv('DATABASE_URL'),
  workerConcurrency: intFromEnv('WORKER_CONCURRENCY', 3),
  jobMaxAttempts: intFromEnv('JOB_MAX_ATTEMPTS', 5),
  jobBaseDelayMs: intFromEnv('JOB_BASE_DELAY_MS', 1000),
  jobStuckTimeoutMs: intFromEnv('JOB_STUCK_TIMEOUT_MS', 60000),
  workerPollIntervalMs: intFromEnv('WORKER_POLL_INTERVAL_MS', 1000),
  workerTaskDelayMs: intFromEnv('WORKER_TASK_DELAY_MS', 2500),
} as const;

export type AppConfig = typeof config;