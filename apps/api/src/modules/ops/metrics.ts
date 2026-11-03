import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Prometheus text exposition at GET /metrics (bearer METRICS_TOKEN; disabled when unset). HTTP counters and latency
 * histograms by route template, plus business health gauges read at scrape time.
 */
export async function metricsRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const requests = new Map<string, number>();
  const hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics') return;
    const k = `method="${req.method}",route="${route}",status="${reply.statusCode}"`;
    requests.set(k, (requests.get(k) ?? 0) + 1);
    const hk = `method="${req.method}",route="${route}"`;
    const h = hist.get(hk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    const sec = reply.elapsedTime / 1000;
    BUCKETS.forEach((b, i) => { if (sec <= b) h.buckets[i]! += 1; });
    h.sum += sec; h.count += 1;
    hist.set(hk, h);
  });

  app.get('/metrics', async (req, reply) => {
    if (!config.METRICS_TOKEN) return reply.code(404).send();
    const given = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${config.METRICS_TOKEN}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.code(401).send();
    const g = async (sql: string) => Number((await db.query(sql)).rows[0]?.v ?? 0);
    const gauges: Array<[string, string, number]> = [
      ['rmn_devices_online', 'Tablets with a heartbeat in the last 10 minutes', await g(`SELECT count(*) v FROM devices WHERE status = 'ACTIVE' AND last_heartbeat_at > now() - interval '10 minutes'`)],
      ['rmn_devices_active_total', 'Tablets with ACTIVE status', await g(`SELECT count(*) v FROM devices WHERE status = 'ACTIVE'`)],
      ['rmn_raw_events_pending_validation', 'Raw playback events awaiting validation', await g(`SELECT count(*) v FROM raw_events r WHERE NOT EXISTS (SELECT 1 FROM validated_events v WHERE v.raw_event_id = r.id)`)],
      ['rmn_events_held_for_review', 'Validated events held for human review', await g(`SELECT count(*) v FROM validated_events WHERE status = 'HELD_REVIEW'`)],
      ['rmn_moderation_cases_open', 'Open content moderation cases', await g(`SELECT count(*) v FROM moderation_cases WHERE status = 'OPEN' AND subject_type = 'VIDEO'`)],
      ['rmn_media_uploads_pending', 'Uploads awaiting processing', await g(`SELECT count(*) v FROM media_uploads WHERE status = 'UPLOADED'`)],
      ['rmn_webhooks_failed', 'Payment webhooks in FAILED state', await g(`SELECT count(*) v FROM webhook_inbox WHERE status = 'FAILED'`)],
      ['rmn_reconciliation_exceptions_open', 'Open reconciliation exceptions', await g(`SELECT count(*) v FROM reconciliation_exceptions WHERE status = 'OPEN'`)],
      ['rmn_email_outbox_pending', 'Queued transactional emails', await g(`SELECT count(*) v FROM email_outbox WHERE status = 'PENDING'`)],
      ['rmn_journal_requests_pending', 'Journal requests awaiting a second approver', await g(`SELECT count(*) v FROM journal_requests WHERE status = 'PENDING'`)],
      ['rmn_ledger_unbalanced_currencies', 'Currencies whose total debits differ from credits (must be 0)', await g(`SELECT count(*) v FROM (SELECT currency FROM journal_lines GROUP BY currency HAVING sum(debit) <> sum(credit)) t`)],
    ];
    const out: string[] = ['# HELP rmn_http_requests_total HTTP requests by route template and status', '# TYPE rmn_http_requests_total counter'];
    for (const [k, v] of requests) out.push(`rmn_http_requests_total{${k}} ${v}`);
    out.push('# HELP rmn_http_request_duration_seconds Request latency', '# TYPE rmn_http_request_duration_seconds histogram');
    for (const [k, h] of hist) {
      BUCKETS.forEach((b, i) => out.push(`rmn_http_request_duration_seconds_bucket{${k},le="${b}"} ${h.buckets[i]}`));
      out.push(`rmn_http_request_duration_seconds_bucket{${k},le="+Inf"} ${h.count}`, `rmn_http_request_duration_seconds_sum{${k}} ${h.sum.toFixed(6)}`, `rmn_http_request_duration_seconds_count{${k}} ${h.count}`);
    }
    for (const [name, help, v] of gauges) out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${v}`);
    return reply.type('text/plain; version=0.0.4').send(out.join('\n') + '\n');
  });
}
