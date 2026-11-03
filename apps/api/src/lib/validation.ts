import { z } from 'zod';
import { badRequest } from './errors.js';

export const uuid = z.string().uuid();
export const minor = z.string().regex(/^\d{1,18}$/, 'amount must be a non-negative integer string of minor units').transform((v) => BigInt(v));
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const idemKey = z.string().min(8).max(200);

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}
