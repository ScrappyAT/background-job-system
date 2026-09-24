import express from 'express';
import { ZodError } from 'zod';

import { ApiError } from './http/errors';
import { renderDeadJobsPage } from './http/deadJobsPage';
import { jobsRouter } from './jobs/jobs.routes';

const SYNTAX_ERROR_MESSAGE = 'Request body is not valid JSON';

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'background-job-system',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/dead-jobs', (_req, res) => {
    res.type('html').send(renderDeadJobsPage());
  });

  app.use('/api/jobs', jobsRouter);

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err instanceof ZodError) {
        res.status(422).json({
          error: {
            status: 422,
            message: 'Validation failed',
            details: err.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
        return;
      }

      if (err instanceof ApiError) {
        res.status(err.status).json({
          error: {
            status: err.status,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        });
        return;
      }

      if (err instanceof SyntaxError && isJsonParseError(err)) {
        res.status(400).json({
          error: { status: 400, message: SYNTAX_ERROR_MESSAGE },
        });
        return;
      }

      console.error('Unhandled request error:', err);
      res.status(500).json({
        error: { status: 500, message: 'Internal server error' },
      });
    }
  );

  return app;
}

function isJsonParseError(err: SyntaxError): boolean {
  return (err as SyntaxError & { type?: string }).type === 'entity.parse.failed';
}