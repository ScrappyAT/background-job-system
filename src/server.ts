import { config } from './config/env';
import { closePool } from './config/database';
import { createApp } from './app';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`background-job-system API listening on http://localhost:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));