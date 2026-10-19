import { test, expect } from '@playwright/test';
import { ensureAuthenticated } from '../utils/auth.js';
import { classifyNonLiveRequest, NonLiveSafetyGuard } from '../utils/non-live-safety.js';

test('authenticate with the configured QA account', async ({ page }) => {
  const authenticatedPage = await ensureAuthenticated(page, true);
  await authenticatedPage.context().close();
});

test('validate authenticated DEV session and non-live security independently', async ({ browser }) => {
  const guard = new NonLiveSafetyGuard();
  const context = await browser.newContext({ baseURL: 'https://dev.beta.graphxserver.io', storageState: 'config/auth.json' });
  await guard.install(context);
  try {
    const page = await context.newPage();
    const authenticatedPage = await ensureAuthenticated(page, false, false);
    expect(authenticatedPage, 'Authentication must validate the saved DEV dashboard and organization').toBe(page);
    await expect(page.getByText('Doe Test org-2', { exact: true })).toBeVisible();
    console.log('AUTHENTICATION_VERIFIED: DEV dashboard and Doe Test org-2; existing session reused.');

    const cases = [
      { method: 'GET', path: '/mockups', body: null, classification: 'navigation', block: true },
      { method: 'POST', path: '/api/trpc/orders.createOrder', body: '{}', classification: 'confirmed-create-order', block: true },
      { method: 'POST', path: '/api/trpc/orders.createOrder,orders.list', body: '{}', classification: 'confirmed-create-order', block: true },
      { method: 'POST', path: '/api/trpc?operationName=orders.createOrder', body: '{}', classification: 'confirmed-create-order', block: true },
      { method: 'POST', path: '/api/trpc', body: JSON.stringify({ operationName: 'orders.createOrder' }), classification: 'confirmed-create-order', block: true },
      { method: 'POST', path: '/api/trpc', body: JSON.stringify({ note: 'orders.createOrder' }), classification: 'ambiguous', block: true },
      { method: 'POST', path: '/api/unverified', body: '{}', classification: 'ambiguous', block: true },
      { method: 'GET', path: '/dashboard', body: null, classification: 'navigation', block: false }
    ];
    for (const sample of cases) {
      const decision = classifyNonLiveRequest(sample.method, `https://dev.beta.graphxserver.io${sample.path}`, sample.body);
      expect(decision.classification).toBe(sample.classification);
      expect(decision.block).toBe(sample.block);
    }
  } finally {
    await context.close();
    const snapshot = guard.snapshot();
    await test.info().attach('non-live-security', { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' });
    console.log(`NON_LIVE_SECURITY ${JSON.stringify(snapshot)}`);
    expect(snapshot.blockFailures, 'Every safety interception must succeed').toBe(0);
    expect(snapshot.unprotectedRequests, 'Confirmed and ambiguous operations must remain blocked').toBe(0);
    expect(snapshot.confirmedCreationAttemptsBlocked, 'Authentication must not attempt order creation').toBe(0);
    expect(new Set(snapshot.requests.map(request => request.requestId)).size).toBe(snapshot.observedRequests);
  }
});
