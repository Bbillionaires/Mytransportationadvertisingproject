import type { Db } from '../db/pool.js';

/**
 * Runs a background job and records the outcome in job_status (one row per job), so the portal's System health page
 * can show "last succeeded 3 minutes ago" or "failing since …" without anyone reading logs. Recording never masks
 * the job's own result or error.
 */
export async function trackJob<T>(db: Db, job: string, run: () => Promise<T>, opts: { isFailure?: (r: T) => string | null } = {}): Promise<T> {
  const note = (sql: string, params: unknown[]) => db.query(sql, params).catch(() => undefined);
  await note(`INSERT INTO job_status (job, last_started_at) VALUES ($1, now()) ON CONFLICT (job) DO UPDATE SET last_started_at = now()`, [job]);
  try {
    const r = await run();
    const failure = opts.isFailure?.(r) ?? null;
    if (failure) {
      await note(`UPDATE job_status SET last_finished_at = now(), last_failed_at = now(), last_error = $2, last_summary = $3, consecutive_failures = consecutive_failures + 1 WHERE job = $1`,
        [job, failure.slice(0, 1000), summarize(r)]);
    } else {
      await note(`UPDATE job_status SET last_finished_at = now(), last_ok_at = now(), last_summary = $2, consecutive_failures = 0 WHERE job = $1`, [job, summarize(r)]);
    }
    return r;
  } catch (e) {
    await note(`UPDATE job_status SET last_finished_at = now(), last_failed_at = now(), last_error = $2, consecutive_failures = consecutive_failures + 1 WHERE job = $1`,
      [job, (e as Error).message.slice(0, 1000)]);
    throw e;
  }
}

/** Small JSON summary: numbers and short strings only, never large or sensitive payloads. */
function summarize(r: unknown): string | null {
  if (!r || typeof r !== 'object') return null;
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 80) out[k] = v;
    else if (Array.isArray(v)) out[`${k}Count`] = v.length;
  }
  return JSON.stringify(out);
}
