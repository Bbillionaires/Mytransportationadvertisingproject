import type { BalanceTransaction, PaymentProvider } from './provider.js';

/** Flatten nested params into Stripe's form encoding: a[b][0][c]=v */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

/**
 * Stripe REST client (no SDK dependency). TEST MODE ONLY while LIVE_PAYMENTS_ENABLED=false: the constructor
 * refuses any key that is not `sk_test_…`. Not yet verified against Stripe from this environment; run the
 * Stripe test-mode checklist in docs/PAYMENTS.md before relying on it.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  constructor(private readonly secretKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly base = 'https://api.stripe.com') {
    if (!/^sk_test_[A-Za-z0-9]+$/.test(secretKey)) throw new Error('only Stripe TEST secret keys (sk_test_…) are accepted while live payments are disabled');
  }

  private async call(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<any> {
    const body = formEncode(params).join('&');
    const url = method === 'GET' && body ? `${this.base}${path}?${body}` : `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`, 'stripe-version': '2024-06-20',
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(method === 'POST' ? { body } : {}),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${method} ${path} failed (${res.status}): ${json?.error?.message ?? 'unknown error'}`);
    return json;
  }

  async createCustomer(p: { email: string; metadata: Record<string, string> }) {
    const c = await this.call('POST', '/v1/customers', { email: p.email, metadata: p.metadata });
    return { id: c.id as string };
  }
  async createSubscriptionCheckout(p: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }) {
    const s = await this.call('POST', '/v1/checkout/sessions', {
      mode: 'subscription', customer: p.customerId, line_items: [{ price: p.priceId, quantity: 1 }], success_url: p.successUrl, cancel_url: p.cancelUrl,
      metadata: p.metadata, subscription_data: { metadata: p.metadata },
    });
    return { id: s.id as string, url: s.url as string };
  }
  async createPaymentCheckout(p: { amountMinor: number; currency: string; description: string; customerEmail: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }) {
    const s = await this.call('POST', '/v1/checkout/sessions', {
      mode: 'payment', customer_email: p.customerEmail, success_url: p.successUrl, cancel_url: p.cancelUrl, metadata: p.metadata,
      payment_intent_data: { metadata: p.metadata },
      line_items: [{ quantity: 1, price_data: { currency: p.currency.toLowerCase(), unit_amount: p.amountMinor, product_data: { name: p.description } } }],
    });
    return { id: s.id as string, url: s.url as string };
  }
  async cancelSubscriptionAtPeriodEnd(id: string) { await this.call('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true }); }
  async refund(p: { paymentIntentId: string; amountMinor: number; metadata: Record<string, string> }) {
    const r = await this.call('POST', '/v1/refunds', { payment_intent: p.paymentIntentId, amount: p.amountMinor, metadata: p.metadata }, `refund-${p.metadata.requestId ?? ''}`);
    return { id: r.id as string };
  }
  async listBalanceTransactions(fromSec: number, toSec: number): Promise<BalanceTransaction[]> {
    const out: BalanceTransaction[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.call('GET', '/v1/balance_transactions', { limit: 100, created: { gte: fromSec, lt: toSec }, ...(after ? { starting_after: after } : {}) });
      for (const t of page.data) out.push({ id: t.id, type: t.type, amount: t.amount, fee: t.fee, net: t.net, currency: String(t.currency).toUpperCase(), created: t.created, source: typeof t.source === 'string' ? t.source : t.source?.id ?? null });
      if (!page.has_more || page.data.length === 0) break;
      after = page.data[page.data.length - 1].id;
    }
    return out;
  }
}
