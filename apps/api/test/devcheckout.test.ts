import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '../src/modules/payments/fake.js';
import { ensureOpenPeriod, org, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
const fake = new FakePaymentProvider('http://127.0.0.1:8080/dev/checkout');
beforeAll(async () => { ctx = await setupApp({ paymentProvider: fake }); await ensureOpenPeriod(ctx.db); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('simulated checkout (development only)', () => {
  it('a prepayment checkout opens the simulated page; paying credits the balance once through the real webhook path', async () => {
    const adv = await org(ctx.db, 'ADVERTISER');
    const admin = await userWithRole(ctx, adv, 'advertiser_admin');
    const r = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${adv}/prepayments`, headers: admin.h, payload: { amountMinor: '25000' } })).json();
    expect(r.checkoutUrl).toBe(`http://127.0.0.1:8080/dev/checkout/${r.sessionId}`);
    const page = await ctx.app.inject({ method: 'GET', url: `/dev/checkout/${r.sessionId}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('$250.00');
    expect(page.body).toContain('No card is charged');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    // Exactly what the browser sends for the page's HTML form.
    const pay = await ctx.app.inject({ method: 'POST', url: `/dev/checkout/${r.sessionId}/pay`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(pay.statusCode).toBe(303);
    expect(pay.headers.location).toMatch(/\/portal\/\?prepayment=success/);
    expect((await ctx.app.inject({ method: 'POST', url: `/dev/checkout/${r.sessionId}/pay` })).statusCode).toBe(409);
    const bal = (await ctx.app.inject({ method: 'GET', url: `/v1/orgs/${adv}/balance`, headers: admin.h })).json();
    expect(bal.balances.USD.prepaidBalance).toBe('25000');
  });

  it('framework client errors keep their 4xx status instead of becoming 500s', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'text/csv' }, payload: 'a,b' });
    expect(r.statusCode).toBe(415);
  });

  it('unknown or malformed sessions are rejected', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/dev/checkout/cs_test_00000000000000000000' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/dev/checkout/../../v1/me' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses to start in production', async () => {
    const { devCheckoutRoutes } = await import('../src/modules/payments/devCheckout.js');
    await expect(devCheckoutRoutes(ctx.app, { config: { ...ctx.config, NODE_ENV: 'production' }, fake })).rejects.toThrow(/never/);
  });
});
