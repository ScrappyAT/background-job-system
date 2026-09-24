export interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  idempotency_key: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface JobApi {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: string;
  runAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
}

export interface DeadJobApi extends JobApi {
  payload: Record<string, unknown>;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

export function toApiJob(
  row: JobRow,
  result: Record<string, unknown> | null = null
): JobApi {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: toIso(row.created_at),
    runAt: toIso(row.run_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    result,
  };
}

export function toDeadJobApi(row: JobRow): DeadJobApi {
  return {
    ...toApiJob(row),
    payload: row.payload,
  };
}