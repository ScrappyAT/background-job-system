import pg from 'pg';

import { config } from './env';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

export async function closePool(): Promise<void> {
  await pool.end();
}