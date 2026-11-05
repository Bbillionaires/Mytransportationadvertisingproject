import { HttpError } from '../../lib/errors.js';
import type { PaymentProvider } from './provider.js';

const off = () => { throw new HttpError(503, 'PAYMENTS_NOT_ENABLED', 'Payments are not enabled yet. No card has been charged.'); };

/**
 * PAYMENTS_PROVIDER=disabled — for staging and early pilots before Stripe is connected (the product owner put Stripe
 * last). Every money-moving call is refused with a clear 503; nothing reaches any processor. Webhooks are rejected
 * because there is no webhook secret.
 */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'disabled';
  async createCustomer(): Promise<{ id: string }> { return off(); }
  async createSubscriptionCheckout(): Promise<{ id: string; url: string }> { return off(); }
  async createPaymentCheckout(): Promise<{ id: string; url: string }> { return off(); }
  async cancelSubscriptionAtPeriodEnd(): Promise<void> { return off(); }
  async refund(): Promise<{ id: string }> { return off(); }
  async listBalanceTransactions() { return []; }
}
