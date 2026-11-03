import { createHmac, timingSafeEqual } from 'node:crypto';

/** Minimal Stripe-shaped event/object types used by our handlers (only fields we read). */
export interface ProviderEvent { id: string; type: string; created: number; livemode: boolean; data: { object: any } }

export interface BalanceTransaction {
  id: string; type: string; amount: number; fee: number; net: number; currency: string; created: number; source: string | null;
}

export interface PaymentProvider {
  name: string;
  createCustomer(p: { email: string; metadata: Record<string, string> }): Promise<{ id: string }>;
  createSubscriptionCheckout(p: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }): Promise<{ id: string; url: string }>;
  createPaymentCheckout(p: { amountMinor: number; currency: string; description: string; customerEmail: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }): Promise<{ id: string; url: string }>;
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
  refund(p: { paymentIntentId: string; amountMinor: number; metadata: Record<string, string> }): Promise<{ id: string }>;
  listBalanceTransactions(fromSec: number, toSec: number): Promise<BalanceTransaction[]>;
}

/**
 * Stripe webhook signature: header `t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>[,v1=...]`.
 * Rejects stale timestamps (default 300 s) to block replay of captured requests.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find((p) => p[0] === 't')?.[1]);
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1] ?? '');
  if (!Number.isInteger(t) || sigs.length === 0 || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && timingSafeEqual(b, expected); });
}

export function stripeSignatureHeader(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}
