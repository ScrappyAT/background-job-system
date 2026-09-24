-- Durable output of successfully processed jobs.
CREATE TABLE job_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE job_results IS
  'Durable output of a successfully processed job. job_id is UNIQUE so a job can never have more than one result row.';