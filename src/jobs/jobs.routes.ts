import { Router } from 'express';

import { ApiError, isUuid } from '../http/errors';

import { createJobSchema } from './jobs.schema';
import { enqueueReviewJob, getJobById } from './jobs.service';

export const jobsRouter = Router();

jobsRouter.post('/', async (req, res) => {
  const input = createJobSchema.parse(req.body);
  const { job, duplicate } = await enqueueReviewJob(input);
  res.status(202).json({ duplicate, job });
});

jobsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) {
    throw new ApiError(400, 'Invalid job id format; expected a UUID');
  }
  const job = await getJobById(id);
  res.json({ job });
});