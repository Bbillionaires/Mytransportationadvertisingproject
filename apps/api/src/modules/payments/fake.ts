import { randomBytes } from 'node:crypto';
import type { BalanceTransaction, PaymentProvider, ProviderEvent } from './provider.js';

const id = (p: string) => `${p}_${randomBytes(10).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

/**
 * In-memory Stripe stand-in for development, demos and tests. It records the calls our code makes and can
 * produce the Stripe-shaped webhook events that would follow (signed by the test helper with the webhook
 * secret), plus balance transactions with Stripe's standard 2.9% + 30¢ card fee for reconciliation.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';  // behaves as the Stripe processor for ledger/reconciliation purposes
  customers = new Map<string, { email: string; metadata: Record<string, string> }>();
  sessions = new Map<string, any>();
  subscriptions = new Map<string, any>();
  balance: BalanceTransaction[] = [];
  canceled: string[] = [];
  refunds: Array<{ id: string; paymentIntentId: string; amountMinor: number }> = [];
  /** With a base URL (dev server), checkout links open the simulated checkout page at base/sessionId. */
  constructor(private readonly checkoutBaseUrl?: string) {}
  private checkoutUrl(sessionId: string) { return this.checkoutBaseUrl ? `${this.checkoutBaseUrl}/${sessionId}` : `https://checkout.stripe.test/${id('pay')}`; }

  async createCustomer(p: { email: string; metadata: Record<string, string> }) { const c = id('cus'); this.customers.set(c, p); return { id: c }; }
  async createSubscriptionCheckout(p: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }) {
    const sid = id('cs_test'); const s = { id: sid, url: this.checkoutUrl(sid), mode: 'subscription', ...p };
    this.sessions.set(s.id, s); return { id: s.id, url: s.url };
  }
  async createPaymentCheckout(p: { amountMinor: number; currency: string; description?: string; customerEmail: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }) {
    const sid = id('cs_test'); const s = { id: sid, url: this.checkoutUrl(sid), mode: 'payment', ...p };
    this.sessions.set(s.id, s); return { id: s.id, url: s.url };
  }
  async cancelSubscriptionAtPeriodEnd(sid: string) { this.canceled.push(sid); }
  async refund(p: { paymentIntentId: string; amountMinor: number }) { const r = { id: id('re'), ...p }; this.refunds.push(r); return { id: r.id }; }
  async listBalanceTransactions(fromSec: number, toSec: number) { return this.balance.filter((t) => t.created >= fromSec && t.created < toSec); }

  static fee(amount: number) { return Math.round(amount * 0.029) + 30; }
  private ev(type: string, object: any): ProviderEvent { return { id: id('evt'), type, created: now(), livemode: false, data: { object } }; }
  private charge(amount: number, currency = 'USD') {
    const ch = id('ch'); const fee = FakePaymentProvider.fee(amount);
    this.balance.push({ id: id('txn'), type: 'charge', amount, fee, net: amount - fee, currency, created: now(), source: ch });
    return ch;
  }

  /** Customer completes the prepayment checkout: returns the payment_intent.succeeded event Stripe would send. */
  completePayment(sessionId: string): ProviderEvent {
    const s = this.sessions.get(sessionId);
    const pi = id('pi'); const ch = this.charge(s.amountMinor, s.currency);
    return this.ev('payment_intent.succeeded', { id: pi, object: 'payment_intent', amount: s.amountMinor, amount_received: s.amountMinor, currency: s.currency.toLowerCase(), latest_charge: ch, metadata: s.metadata, created: now() });
  }

  /** Customer completes the subscription checkout: subscription.created then invoice.paid. */
  completeSubscription(sessionId: string, amount = 3000, tax = 0): { subscriptionCreated: ProviderEvent; invoicePaid: ProviderEvent; subscription: any } {
    const s = this.sessions.get(sessionId);
    const sub = { id: id('sub'), object: 'subscription', customer: s.customerId, status: 'active', cancel_at_period_end: false, current_period_end: now() + 30 * 86400, metadata: s.metadata, items: { data: [{ price: { unit_amount: amount, currency: 'usd' } }] } };
    this.subscriptions.set(sub.id, sub);
    return { subscription: sub, subscriptionCreated: this.ev('customer.subscription.created', sub), invoicePaid: this.renew(sub.id, amount, tax) };
  }
  renew(subId: string, amount = 3000, tax = 0): ProviderEvent {
    const sub = this.subscriptions.get(subId); const ch = this.charge(amount + tax);
    return this.ev('invoice.paid', { id: id('in'), object: 'invoice', subscription: sub.id, customer: sub.customer, amount_paid: amount + tax, tax, currency: 'usd', charge: ch, subscription_details: { metadata: sub.metadata }, status_transitions: { paid_at: now() } });
  }
  subscriptionEvent(subId: string, patch: Record<string, unknown>, type = 'customer.subscription.updated'): ProviderEvent {
    const sub = Object.assign(this.subscriptions.get(subId), patch); return this.ev(type, { ...sub });
  }
  /** Stripe sends charge.refunded with the cumulative refunded amount and the refund list. */
  refundedEvent(paymentIntentId: string, chargeId: string, amount: number, totalRefunded: number, refundId: string): ProviderEvent {
    this.balance.push({ id: id('txn'), type: 'refund', amount: -amount, fee: 0, net: -amount, currency: 'USD', created: now(), source: refundId });
    return this.ev('charge.refunded', { id: chargeId, object: 'charge', payment_intent: paymentIntentId, amount_refunded: totalRefunded, currency: 'usd', refunds: { data: [{ id: refundId, amount, status: 'succeeded' }] } });
  }
  payout(amount: number) { this.balance.push({ id: id('txn'), type: 'payout', amount: -amount, fee: 0, net: -amount, currency: 'USD', created: now(), source: id('po') }); }
  disputeEvent(chargeId: string, amount: number): ProviderEvent { return this.ev('charge.dispute.created', { id: id('dp'), charge: chargeId, amount, currency: 'usd', reason: 'fraudulent' }); }
}
