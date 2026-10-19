import type { Page, Request, Response } from '@playwright/test';

export type CreateOrderRequestEvidence = {
  method: string;
  timestamp: string;
  responseStatus: number | null;
  responseStatusText: string | null;
  safeErrorDetail: string | null;
  endpointHost: string;
  endpointPath: string;
  operation: 'orders.createOrder';
};

export type CreateOrderTelemetrySnapshot = {
  distinctRequestCount: number;
  requests: CreateOrderRequestEvidence[];
};

function isCreateOrderRequest(request: Request): boolean {
  const url = new URL(request.url());
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the encoded path if it is not valid URI encoding.
  }

  if (/(?:^|\/)orders\.createOrder(?:\/|$)/i.test(pathname)) return true;
  if (url.searchParams.get('operationName') === 'orders.createOrder') return true;

  const body = request.postData() ?? '';
  if (/orders\.createOrder/i.test(body)) return true;

  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const operationName = (parsed as Record<string, unknown>).operationName;
      if (operationName === 'orders.createOrder') return true;
    }
  } catch {
    // Non-JSON requests are matched by their route or operation text above.
  }

  return false;
}

function safeEndpoint(urlValue: string): Pick<CreateOrderRequestEvidence, 'endpointHost' | 'endpointPath'> {
  const url = new URL(urlValue);
  return {
    endpointHost: url.hostname,
    endpointPath: url.pathname.replace(/\/[A-Fa-f0-9-]{16,}(?=\/|$)/g, '/:id')
  };
}

export class CreateOrderTelemetry {
  private readonly requests = new Map<Request, CreateOrderRequestEvidence>();

  constructor(private readonly page: Page) {}

  private readonly onRequest = (request: Request) => {
    if (!isCreateOrderRequest(request)) return;
    this.requests.set(request, {
      method: request.method(),
      timestamp: new Date().toISOString(),
      responseStatus: null,
      responseStatusText: null,
      safeErrorDetail: null,
      ...safeEndpoint(request.url()),
      operation: 'orders.createOrder'
    });
  };

  private readonly onResponse = (response: Response) => {
    const evidence = this.requests.get(response.request());
    if (evidence) {
      evidence.responseStatus = response.status();
      evidence.responseStatusText = response.statusText().replace(/[\r\n\t]+/g, ' ').slice(0, 120);
      if (!response.ok()) evidence.safeErrorDetail = `HTTP ${evidence.responseStatus} ${evidence.responseStatusText}`.trim();
    }
  };

  start(): void {
    this.page.on('request', this.onRequest);
    this.page.on('response', this.onResponse);
  }

  stop(): void {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
  }

  snapshot(): CreateOrderTelemetrySnapshot {
    const requests = [...this.requests.values()].map(request => ({ ...request }));
    return { distinctRequestCount: requests.length, requests };
  }
}
