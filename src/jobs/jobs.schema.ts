import { z } from 'zod';

export const createJobSchema = z.object({
  review: z.string().trim().min(1, 'review is required and must be a non-empty string'),
  idempotencyKey: z
    .string()
    .trim()
    .min(1, 'idempotencyKey is required and must be a non-empty string'),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;