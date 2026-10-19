import { randomUUID } from 'node:crypto';
import type { BrowserContext, Request, Route } from '@playwright/test';

type Classification = 'navigation' | 'confirmed-create-order' | 'ambiguous';
type Decision = { classification: Classification; reason: string; block: boolean };
export type SafeRequestRecord = {
  requestId: string;
  method: string;
  hostname: string;
  pathname: string;
  classification: Classification;
  reason: string;
  disposition: 'observed' | 'blocked' | 'continued' | 'block-failed';
};

export function classifyNonLiveRequest(method: string, urlValue: string, body: string | null): Decision {
  const url = new URL(urlValue);
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { pathname = url.pathname; }
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  let bodyOperation = false;
  try {
    const parsed: unknown = JSON.parse(body ?? 'null');
    const operations: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    bodyOperation = operations.some(operation => operation !== null && typeof operation === 'object'
      && 'operationName' in operation && operation.operationName === 'orders.createOrder');
  } catch { bodyOperation = false; }
  const operation = pathname.split(/[/,]/).includes('orders.createOrder')
    || url.searchParams.get('operationName') === 'orders.createOrder' || bodyOperation;
  if (operation && mutating) return { classification: 'confirmed-create-order', reason: 'explicit-orders.createOrder-operation', block: true };
  if (operation || /orders\.createOrder/i.test(`${pathname} ${url.search} ${body ?? ''}`)) {
    return { classification: 'ambiguous', reason: 'unverified-create-order-reference', block: true };
  }
  if (mutating) return { classification: 'ambiguous', reason: 'unverified-mutating-request', block: true };
  if (pathname === '/mockups') return { classification: 'navigation', reason: 'protected-mockups-read', block: true };
  return { classification: 'navigation', reason: 'read-only-request', block: false };
}

function safePath(pathname: string): string {
  const known = new Set(['', 'api', 'trpc', 'mockups', 'dashboard', 'auth', 'get-session', 'refresh',
    'sign-in', 'select-organization', 'oauth2', 'authorize', 'public-client-prelogin', 'passkey',
    'generate-authenticate-options', 'otel', 'otel.clientConfig', 'v1', 'traces', 'orders.createOrder', '_next', 'static', 'chunks']);
  return pathname.split('/').map(segment => known.has(segment) ? segment : ':redacted').join('/');
}

export class NonLiveSafetyGuard {
  private readonly records = new Map<Request, SafeRequestRecord>();

  private observe(request: Request): SafeRequestRecord {
    const existing = this.records.get(request);
    if (existing) return existing;
    const url = new URL(request.url());
    const decision = classifyNonLiveRequest(request.method(), request.url(), request.postData());
    const record: SafeRequestRecord = {
      requestId: randomUUID(), method: request.method(), hostname: url.hostname, pathname: safePath(url.pathname),
      classification: decision.classification, reason: decision.reason, disposition: 'observed'
    };
    this.records.set(request, record);
    return record;
  }

  private readonly onRequest = (request: Request) => { this.observe(request); };

  private readonly intercept = async (route: Route) => {
    const request = route.request();
    const record = this.observe(request);
    const decision = classifyNonLiveRequest(request.method(), request.url(), request.postData());
    if (decision.block) {
      try {
        await route.abort('blockedbyclient');
        record.disposition = 'blocked';
      } catch {
        record.disposition = 'block-failed';
        throw new Error('NON_LIVE_SAFETY_BLOCK_FAILED');
      }
    } else {
      await route.continue();
      record.disposition = 'continued';
    }
  };

  async install(context: BrowserContext): Promise<void> {
    context.on('request', this.onRequest);
    await context.route('**/*', this.intercept);
  }

  snapshot() {
    const requests = [...this.records.values()].map(record => ({ ...record }));
    return {
      observedRequests: requests.length,
      confirmedCreationAttemptsBlocked: requests.filter(record => record.classification === 'confirmed-create-order' && record.disposition === 'blocked').length,
      ambiguousRequestsBlocked: requests.filter(record => record.classification === 'ambiguous' && record.disposition === 'blocked').length,
      navigationRequestsBlocked: requests.filter(record => record.classification === 'navigation' && record.disposition === 'blocked').length,
      unprotectedRequests: requests.filter(record => record.classification !== 'navigation' && record.disposition !== 'blocked').length,
      blockFailures: requests.filter(record => record.disposition === 'block-failed').length,
      requests
    };
  }
}