import 'dotenv/config';
import { test, expect, type Request, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadCase, validateArtworkFile } from '../utils/config.js';
import { MockupPage } from '../pages/mockup.page.js';
import { waitForOrder, downloadCompletedOrder } from '../utils/order-monitor.js';
import { verifyOutput } from '../utils/output-verification.js';
import { upsertMinimalResult } from '../utils/minimal-report.js';
import { MockupSession } from '../utils/auth.js';
import { NonLiveSafetyGuard } from '../utils/non-live-safety.js';

const DEV = 'https://dev.beta.graphxserver.io';
const isLive = process.env.GXS_EXECUTION_MODE === 'live';
const format = (process.env.GXS_TEST_FORMAT ?? 'PNG').toUpperCase();
const size = Number(process.env.GXS_TEST_SIZE ?? '2000');
const orderPattern = /MCKP-[A-Z0-9]+/g;

function createOrder(req: Request): boolean {
  if (req.method() !== 'POST') return false;
  const u = new URL(req.url());
  return /orders\.createOrder/i.test(u.pathname) || u.searchParams.get('operationName') === 'orders.createOrder' || /orders\.createOrder/i.test(req.postData() ?? '');
}

test('minimal DEV mockup generation (one controlled submission)', async ({page: initialPage}) => {
  let page = initialPage;
  const session = new MockupSession(page);
  test.setTimeout(8 * 60_000);
  const c = loadCase();
  if (c.environment !== DEV || new URL(String(test.info().project.use.baseURL ?? DEV)).origin !== DEV) throw new Error('DEV_ONLY');
  if (!Number.isInteger(size) || size < 1 || size > 9000) throw new Error('INVALID_TEST_SIZE');
  if (!['PNG', 'JPG', 'JPEG', 'WEBP', 'PDF'].includes(format)) throw new Error('INVALID_TEST_FORMAT');
  const selectedFormat = format === 'JPG' ? 'JPEG' : format;
  if (isLive && !(process.env.ALLOW_SUBMIT === 'true' && process.env.APPROVE_SUBMISSIONS === 'true' && process.env.GXS_MAX_ORDERS === '1')) throw new Error('LIVE_NOT_AUTHORIZED: requires three explicit flags and max orders 1');
  if (process.env.GXS_EXECUTION_MODE !== 'dry-run' && !isLive) throw new Error('EXECUTION_MODE_REQUIRED');
  validateArtworkFile(c.productDecorations[c.productSku]?.artworkPath ?? c.artworkPath);
  const id = randomUUID(), started = Date.now();
  const data: Record<string, unknown> = { testId:id, timestamp:new Date().toISOString(), sku:c.productSku, format, width:size, height:size, phase:'start', httpStatuses:'', orderId:'', generationStatus:'Not Submitted', durationMs:'', outputPath:'', error:'' };
  const statuses: number[] = [];
  const pending: Promise<void>[] = [];
  let attempted = false;
  const safetyGuard = new NonLiveSafetyGuard();
  let capturedOrder = '';
  const onResponse = (r: Response) => {
    if (!createOrder(r.request())) return;
    statuses.push(r.status());
    pending.push(r.text().then(text => {
      // Only extract the order ID. Do not retain response bodies or credentials.
      const match = text.match(orderPattern);
      if (match?.length === 1 && !capturedOrder) capturedOrder = match[0];
    }).catch(() => {}));
  };
  try {
    page = await session.prepare();
    if (!isLive) await safetyGuard.install(page.context());
    page.on('response', onResponse);
    const wizard = new MockupPage(page);
    const productCase = { ...c, format: selectedFormat as typeof c.format, widthPx: size, heightPx: size, location: c.productDecorations[c.productSku]?.location, artworkPath: c.productDecorations[c.productSku]?.artworkPath ?? c.artworkPath };
    await wizard.openWizard();
    await wizard.chooseProduct(productCase);
    await wizard.configureDecoration(productCase);
    await wizard.setSummary(productCase);
    await page.screenshot({path:`reports/minimal-summary-${id}.png`, fullPage:true});
    data.phase = 'Summary verified';
    if (!isLive) { data.generationStatus = 'Not Submitted'; return; }
    // Record an attempted submission BEFORE the click, so failures cannot trigger a blind retry.
    attempted = true;
    data.phase = 'Generate attempted';
    data.generationStatus = 'Submission Uncertain';
    upsertMinimalResult(data);
    try { await page.getByRole('button',{name:/Generate mock-up/i}).click({timeout:15_000}); }
    catch(e) { data.error = `Generate click interrupted: ${e instanceof Error?e.message.split('\n')[0]:'unknown'}`; }
    // Allow in-flight response events a bounded window to arrive.
    await new Promise(resolve => setTimeout(resolve, 2500));
    await Promise.allSettled(pending);
    data.httpStatuses = statuses.join(';');
    if (statuses.some(s=>s===401 || s===403)) {
      data.phase = 'Submission rejected'; data.generationStatus = 'HTTP Rejected';
      data.error = `Create order returned authorization failure ${statuses.filter(s=>s===401||s===403).join(';')}`;
      return;
    }
    if (!capturedOrder) {
      data.phase='Submission uncertain';
      data.error ||= 'Order ID was not confirmed from the observed createOrder response. Inspect DEV orders before another live execution.';
      return;
    }
    data.orderId = capturedOrder;
    data.phase = 'Order created';
    data.generationStatus = 'Pending';
    upsertMinimalResult(data);
    const observation = await waitForOrder(capturedOrder,{intervalMs:10000,timeoutMs:Math.min(c.pollTimeoutMs,240000)});
    data.durationMs = Date.now()-started;
    data.generationStatus = observation.status;
    data.phase = 'Monitoring completed';
    if (observation.status === 'Completed') {
      try {
        const file = await downloadCompletedOrder(capturedOrder);
        data.outputPath = file;
        await verifyOutput(file,format as typeof c.format,size,size);
        data.phase = 'Output verified';
        data.error = ''; // Verified output supersedes a transient click interruption.
      } catch (error) {
        data.phase = 'Output validation failed';
        data.error = `OUTPUT_VALIDATION_FAILED: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
      }
    } else if (observation.status === 'Failed') {
      data.phase = 'Generation failed (confirmed)';
      data.error = `GENERATION_FAILED: ${capturedOrder}`;
    }
    else data.error = `MONITORING_${observation.status}: do not resubmit automatically`;
  } catch(e) {
    data.error = e instanceof Error ? e.message.split('\n').slice(0,3).join(' ') : String(e);
    data.phase = attempted ? 'Execution interrupted after Generate attempt' : 'Pre-submission error';
    if (attempted && !capturedOrder) data.generationStatus = 'Submission Uncertain';
  } finally {
    page.off('response',onResponse);
    console.log(`SESSION_VALIDATION ${JSON.stringify(session.evidence)}`);
    console.log(`SUBMISSION_SAFETY ${JSON.stringify({ generateAttempted: attempted, security: safetyGuard.snapshot(), createOrderResponses: statuses.length })}`);
    if (!isLive) await test.info().attach('non-live-security', { body: JSON.stringify(safetyGuard.snapshot(), null, 2), contentType: 'application/json' });
    await test.info().attach('session-validation', { body: JSON.stringify(session.evidence), contentType: 'application/json' });
    data.httpStatuses = statuses.join(';');
    if (capturedOrder) data.orderId = capturedOrder;
    upsertMinimalResult(data);
    await session.close();
    if (!isLive) {
      const safety = safetyGuard.snapshot();
      expect(safety.blockFailures, 'Safety blocks must succeed').toBe(0);
      expect(safety.unprotectedRequests, 'Potentially mutating requests must remain blocked').toBe(0);
      expect(safety.confirmedCreationAttemptsBlocked, 'Dry-run must not attempt orders.createOrder').toBe(0);
    }
  }
  // Confirmed terminal business outcomes are QA findings, not runner/infrastructure failures.
  // Matrix runner separately inspects the persisted row and only proceeds when the
  // order ID and terminal outcome are unequivocally known.
  const terminalFinding = Boolean(data.orderId) && (
    (data.generationStatus === 'Failed' && data.phase === 'Generation failed (confirmed)') ||
    (data.generationStatus === 'Completed' && data.phase === 'Output validation failed')
  );
  if (data.error && !terminalFinding) throw new Error(`MINIMAL_MOCKUP_TEST: ${data.phase}: ${data.error}`);
  if (isLive && !terminalFinding) expect(data.generationStatus).toBe('Completed');
});
