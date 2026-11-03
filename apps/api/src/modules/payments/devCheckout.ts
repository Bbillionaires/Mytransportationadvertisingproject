import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import type { FakePaymentProvider } from './fake.js';
import { stripeSignatureHeader } from './provider.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Simulated hosted checkout for local development and demos (PAYMENTS_PROVIDER=fake only; never in production).
 * "Pay" produces the same signed webhook events Stripe would send and feeds them through the real webhook endpoint,
 * so the ledger, receipts and balances follow the production code path. No money moves.
 */
export async function devCheckoutRoutes(app: FastifyInstance, { config, fake }: { config: Config; fake: FakePaymentProvider }) {
  if (config.NODE_ENV === 'production') throw new Error('simulated checkout must never be registered in production');
  // The page posts a plain HTML form; its (empty) body carries nothing we read. Scoped to this plugin only.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => done(null, {}));
  const params = z.object({ sessionId: z.string().regex(/^cs_test_[0-9a-f]{20}$/) });
  const session = (id: string) => {
    const s = fake.sessions.get(id);
    if (!s) throw notFound('checkout session not found (simulated sessions are lost when the dev server restarts)');
    return s;
  };

  app.get('/dev/checkout/:sessionId', async (req, reply) => {
    const { sessionId } = parse(params, req.params);
    const s = session(sessionId);
    const amount = s.mode === 'payment' ? `$${(s.amountMinor / 100).toFixed(2)}` : '$30.00 / month';
    const form = s.completed
      ? '<p>This checkout is already complete.</p>'
      : `<form method="post" action="/dev/checkout/${sessionId}/pay"><button type="submit" id="pay">Pay ${amount} (simulated)</button> <a href="${esc(s.cancelUrl)}">Cancel</a></form>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated checkout</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #dde2e8;border-radius:12px;padding:28px;max-width:420px;width:calc(100% - 32px)}
.warn{background:#fff8c5;border-radius:8px;padding:10px 12px;font-size:14px}.amt{font-size:32px;font-weight:700;margin:8px 0}button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#1f6feb;color:#fff;font-weight:600;cursor:pointer}a{margin-left:12px;color:#555}</style></head>
<body><main><p class="warn"><strong>Simulated checkout (development only).</strong> No card is charged and no money moves. Production uses Stripe's hosted checkout.</p>
<p>${esc(String(s.description ?? (s.mode === 'payment' ? 'Payment' : 'Subscription')))}</p><p class="amt" id="amount">${amount}</p>${form}</main></body></html>`;
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'").send(html);
  });

  app.post('/dev/checkout/:sessionId/pay', async (req, reply) => {
    const { sessionId } = parse(params, req.params);
    const s = session(sessionId);
    if (s.completed) throw conflict('checkout already completed');
    s.completed = true;
    const events = s.mode === 'payment' ? [fake.completePayment(sessionId)] : (() => { const r = fake.completeSubscription(sessionId); return [r.subscriptionCreated, r.invoicePaid]; })();
    for (const e of events) {
      const body = JSON.stringify(e);
      const r = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: body,
        headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(body, config.STRIPE_WEBHOOK_SECRET) } });
      if (r.statusCode >= 300) req.log.error({ status: r.statusCode, body: r.body }, 'simulated webhook rejected');
    }
    return reply.redirect(s.successUrl, 303);
  });
}
