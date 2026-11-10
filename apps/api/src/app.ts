import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { runWithDbScope, type Db } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { dbScopeFor, resolveSession } from './auth/context.js';
import { identityRoutes } from './modules/identity/routes.js';
import { orgRoutes } from './modules/orgs/routes.js';
import { fleetRoutes } from './modules/fleets/routes.js';
import { deviceRoutes } from './modules/devices/routes.js';
import type { AttestationTrust } from './modules/devices/attestation.js';
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
import { healthRoutes } from './modules/ops/health.js';
import { riderRoutes } from './modules/riders/routes.js';
import { engagementRoutes } from './modules/riders/engagement.js';
import type { PaymentProvider } from './modules/payments/provider.js';
import { StripeProvider } from './modules/payments/stripe.js';
import { FakePaymentProvider } from './modules/payments/fake.js';
import { DisabledPaymentProvider } from './modules/payments/disabled.js';
import { devCheckoutRoutes } from './modules/payments/devCheckout.js';
import { platformRoutes } from './modules/platform/routes.js';
import { mediaOrigins } from './lib/objectStore.js';

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

export async function buildApp(opts: { config: Config; db: Db; logger?: boolean | object; paymentProvider?: PaymentProvider; attestationTrust?: AttestationTrust }): Promise<FastifyInstance> {
  const { config, db } = opts;
  const provider = opts.paymentProvider ?? (config.PAYMENTS_PROVIDER === 'stripe' ? new StripeProvider(config.STRIPE_SECRET_KEY!) : config.PAYMENTS_PROVIDER === 'disabled' ? new DisabledPaymentProvider() : new FakePaymentProvider(`${config.APP_PUBLIC_URL}/dev/checkout`));
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
  // Signed tablet traffic is limited per device, not per IP: many tablets can share one carrier (CGNAT) address.
  // A forged X-Device-Id only moves a request into another bucket; it is still rejected at the signature check.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute',
    keyGenerator: (req) => { const d = req.headers['x-device-id']; return typeof d === 'string' && UUID_RE.test(d) && req.url.startsWith('/v1/devices/') ? `device:${d.toLowerCase()}` : req.ip; },
    ...(config.NODE_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true' ? { allowList: () => true } : {}),
  });

  // Database tenant scope (row-level security, migration 0016): every route handler runs with the signed-in user's
  // organizations; platform staff get 'platform'; unauthenticated callers (tablets, riders, integration keys, sign-up)
  // run in the system scope and are constrained by their own authentication and the app's checks.
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function scoped(this: unknown, req, reply) {
      return runWithDbScope(dbScopeFor(req.auth), () => (handler as any).call(this, req, reply));
    } as typeof handler;
  });

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
    // Framework client errors (unsupported media type, body too large, malformed JSON…) keep their 4xx status.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: String(err.code ?? 'CLIENT_ERROR'), message: err.message }, requestId: req.id });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' }, requestId: req.id });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await db.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  await metricsRoutes(app, { db, config }); // root-level hooks so every route is measured
  await app.register(healthRoutes, { db, config });
  await app.register(identityRoutes, { db, config });
  await app.register(accountRoutes, { db, config });
  await app.register(impersonationRoutes, { db });
  await app.register(orgRoutes, { db });
  await app.register(fleetRoutes, { db });
  await app.register(deviceRoutes, { db, config, attestationTrust: opts.attestationTrust });
  await app.register(ledgerRoutes, { db, provider });
  await app.register(revenueRoutes, { db });
  await app.register(eventIngestRoutes, { db, config });
  await app.register(eventRoutes, { db, config });
  await app.register(campaignRoutes, { db, config });
  await app.register(playlistRoutes, { db, config });
  await app.register(mediaRoutes, { db, config });
  await app.register(paymentRoutes, { db, config, provider });
  if (provider instanceof FakePaymentProvider && config.NODE_ENV !== 'production') await app.register(devCheckoutRoutes, { config, fake: provider });
  await app.register(commissionRoutes, { db, config });
  await app.register(reportRoutes, { db });
  await app.register(riderRoutes, { db, config });
  await app.register(engagementRoutes, { db, config });
  await app.register(platformRoutes, { db });

  // The old single-page admin console was retired in favour of the business portal (session 19); keep its URL working.
  app.get('/admin', async (_req, reply) => reply.redirect('/portal/'));
  app.get('/admin/', async (_req, reply) => reply.redirect('/portal/'));
  app.get('/', async (_req, reply) => reply.redirect('/portal/'));

  // Static web apps built by esbuild: fixed file lists, no directory serving, strict CSP on the HTML.
  const mediaOrigin = mediaOrigins(config).join(' ');
  const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', map: 'application/json', css: 'text/css; charset=utf-8',
    webmanifest: 'application/manifest+json', svg: 'image/svg+xml' };
  const webApp = (prefix: string, dir: string, files: string[], csp: string, permissions: string) => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), dir);
    const allowed = new Set(files);
    app.get(`/${prefix}`, async (req, reply) => reply.redirect(`/${prefix}/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));
    app.get(`/${prefix}/`, async (req, reply) => reply.redirect(`/${prefix}/index.html${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));
    app.get(`/${prefix}/:file`, async (req, reply) => {
      const f = (req.params as { file: string }).file;
      if (!allowed.has(f)) return reply.code(404).send();
      const body = await readFile(path.join(root, f)).catch(() => null);
      if (!body) return reply.code(404).type('text/plain').send(`${prefix} not built: run npm run build -w @rmn/${prefix}`);
      if (f === 'index.html') reply.header('content-security-policy', csp).header('permissions-policy', permissions);
      if (f === 'sw.js') reply.header('service-worker-allowed', `/${prefix}/`);
      return reply.type(TYPES[f.split('.').pop()!]!).header('cache-control', f === 'index.html' || f === 'sw.js' ? 'no-cache' : 'public, max-age=300').send(body);
    });
  };
  // Passenger tablet web player (apps/player).
  webApp('player', '../../player/dist', ['index.html', 'player.js', 'player.js.map', 'player.css'],
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${mediaOrigin}; media-src 'self' blob: ${mediaOrigin}; connect-src 'self' ${mediaOrigin}; frame-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'geolocation=(self), camera=(), microphone=()');
  // Rider phone web app (apps/rider), installable PWA.
  webApp('rider', '../../rider/dist', ['index.html', 'rider.js', 'rider.js.map', 'rider.css', 'manifest.webmanifest', 'sw.js', 'icon.svg'],
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'camera=(self), geolocation=(), microphone=()');
  // Business portal (apps/portal): fleet operators first, other roles follow.
  webApp('portal', '../../portal/dist', ['index.html', 'portal.js', 'portal.js.map', 'portal.css'],
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${mediaOrigin}; media-src ${mediaOrigin}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'camera=(), geolocation=(), microphone=()');
  return app;
}
