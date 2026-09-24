import fs from 'fs';
import path from 'path';

import pg from 'pg';

import { config } from '../../config/env';

const MIGRATIONS_TABLE = 'schema_migrations';

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE}`
  );
  return new Set(rows.map((row) => row.name));
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const migrationsDir = __dirname;
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock(388395019629000)');

    await ensureMigrationsTable(client);
    const alreadyApplied = await getAppliedMigrations(client);

    for (const file of migrationFiles) {
      if (alreadyApplied.has(file)) {
        skipped.push(file);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`,
          [file]
        );
        await client.query('COMMIT');
        applied.push(file);
        console.log(`Applied migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration "${file}" failed: ${errorMessage(error)}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(388395019629000)').catch(() => undefined);
    await client.end();
  }

  return { applied, skipped };
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map((inner) => errorMessage(inner)).join('; ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  const { applied, skipped } = await runMigrations();
  console.log(
    `Migrations complete. Applied: ${applied.length}, already applied (skipped): ${skipped.length}.`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Migration run failed:', errorMessage(error));
    process.exit(1);
  });
}