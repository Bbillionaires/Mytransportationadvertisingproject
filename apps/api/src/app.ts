import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { resolveSession } from './auth/context.js';
import { identityRoutes } from './modules/identity/routes.js';
import { orgRoutes } from './modules/orgs/routes.js';
import { fleetRoutes } from './modules/fleets/routes.js';
import { deviceRoutes } from './modules/devices/routes.js';
import { ledgerRoutes } from './modules/ledger/routes.js';
import { revenueRoutes } from './modules/revenue/routes.js';
import { eventIngestRoutes } from './modules/events/ingest.js';
import { eventRoutes } from './modules/events/routes.js';
import { campaignRoutes } from './modules/campaigns/routes.js';
import { playlistRoutes } from './modules/campaigns/playlist.js';
import { mediaRoutes } from './modules/media/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { commissionRoutes } from './modules/commissions/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { accountRoutes } from './modules/identity/accounts.js';
import { impersonationRoutes } from './modules/identity/impersonation.js';
import { metricsRoutes } from './modules/ops/metrics.js';
import type { PaymentProvider } from './modules/payments/provider.js';
import { StripeProvider } from './modules/payments/stripe.js';
import { FakePaymentProvider } from './modules/payments/fake.js';

/** Postgres error codes raised by our integrity triggers/constraints, surfaced as client errors. */
const PG_CLIENT_ERRORS: Record<string, [number, string]> = {
  '23505': [409, 'CONFLICT'],
  '23503': [422, 'REFERENCE_VIOLATION'],
  '23514': [422, 'INTEGRITY_VIOLATION'],
  '23P01': [409, 'OVERLAP_VIOLATION'],
  '42501': [403, 'IMMUTABLE_RECORD'],
  '22P02': [400, 'BAD_REQUEST'],
};

/** Domain errors from @rmn/finance-core: the request violates a financial rule. */
const FINANCE_RULE_ERRORS = new Set(['MoneyError', 'AllocationError', 'RuleError', 'WaterfallError', 'PartySplitError', 'PoolError']);

export async function buildApp(opts: { config: Config; db: Db; logger?: boolean | object; paymentProvider?: PaymentProvider }): Promise<FastifyInstance> {
  const { config, db } = opts;
  const provider = opts.paymentProvider ?? (config.PAYMENTS_PROVIDER === 'stripe' ? new StripeProvider(config.STRIPE_SECRET_KEY!) : new FakePaymentProvider());
  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers["x-device-signature"]'] },
    bodyLimit: 1024 * 1024,
    trustProxy: config.NODE_ENV === 'production',
    genReqId: () => crypto.randomUUID(),
  });

  // Keep the raw body: device requests are signed over its exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, undefined);
    try { done(null, JSON.parse(body as string)); } catch { done(new HttpError(400, 'BAD_JSON', 'invalid JSON body'), undefined); }
  });

  // Disabled only for the automated test suite, which issues many logins from one address.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', ...(config.NODE_ENV === 'test' ? { allowList: () => true } : {}) });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (config.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (req.url.startsWith('/v1/')) req.auth = await resolveSession(db, req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    if (FINANCE_RULE_ERRORS.has(err.name)) return reply.code(422).send({ error: { code: 'FINANCIAL_RULE_VIOLATION', message: err.message }, requestId: req.id });
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'too many requests' }, requestId: req.id });
    const pg = typeof err.code === 'string' ? PG_CLIENT_ERRORS[err.code] : undefined;
    if (pg) return reply.code(pg[0]).send({ error: { code: pg[1], message: err.message }, requestId: req.id });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: err.message }, requestId: req.id });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' }, requestId: req.id });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await db.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  await metricsRoutes(app, { db, config }); // root-level hooks so every route is measured
  await app.register(identityRoutes, { db, config });
  await app.register(accountRoutes, { db, config });
  await app.register(impersonationRoutes, { db });
  await app.register(orgRoutes, { db });
  await app.register(fleetRoutes, { db });
  await app.register(deviceRoutes, { db, config });
  await app.register(ledgerRoutes, { db, provider });
  await app.register(revenueRoutes, { db });
  await app.register(eventIngestRoutes, { db, config });
  await app.register(eventRoutes, { db, config });
  await app.register(campaignRoutes, { db, config });
  await app.register(playlistRoutes, { db, config });
  await app.register(mediaRoutes, { db, config });
  await app.register(paymentRoutes, { db, config, provider });
  await app.register(commissionRoutes, { db, config });
  await app.register(reportRoutes, { db });

  // The admin shell is a single static page; all data comes from the permission-checked API.
  const adminHtml = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');
  const sendAdmin = async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'").send(adminHtml);
  app.get('/admin', sendAdmin);
  app.get('/admin/', sendAdmin);
  app.get('/', async (_req, reply) => reply.redirect('/admin/'));
  return app;
}
