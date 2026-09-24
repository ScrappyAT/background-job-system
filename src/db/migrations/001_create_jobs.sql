CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'pending',
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL,
  last_error       text,
  run_at           timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_jobs_status
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  CONSTRAINT chk_jobs_attempts_non_negative
    CHECK (attempts >= 0),
  CONSTRAINT chk_jobs_max_attempts_positive
    CHECK (max_attempts >= 1),
  CONSTRAINT chk_jobs_attempts_within_bounds
    CHECK (attempts <= max_attempts)
);

COMMENT ON COLUMN jobs.status IS
  'pending = eligible to run, processing = claimed by a worker, succeeded = done, failed = an attempt failed but may retry, dead = attempts exhausted, requires intervention';

-- Supports finding pending jobs whose run_at has arrived.
CREATE INDEX idx_jobs_eligible
  ON jobs (run_at)
  WHERE status = 'pending';

-- Supports finding processing jobs that may be stuck (started long ago, never finished).
CREATE INDEX idx_jobs_stuck_processing
  ON jobs (started_at)
  WHERE status = 'processing';

-- Keeps updated_at current whenever a row changes.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_set_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();