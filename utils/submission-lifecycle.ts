import type { Page } from '@playwright/test';

export type OrderListPageFactory = () => Promise<Page>;
export type OrderListLoader = (page: Page) => Promise<void>;

export function extractOrderIds(rowTexts: string[]): Set<string> {
  return new Set(rowTexts.flatMap(text => text.match(/MCKP-[A-Z0-9]+/g) ?? []));
}

export async function captureExistingOrderIds(options: {
  createPage: OrderListPageFactory;
  loadOrderList: OrderListLoader;
  parentPageIsOpen: () => boolean;
}): Promise<Set<string>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!options.parentPageIsOpen()) {
      throw new Error('PRE_SUBMISSION_PARENT_PAGE_CLOSED: Generate was not attempted.');
    }

    let auxiliaryPage: Page | undefined;
    try {
      auxiliaryPage = await options.createPage();
      await options.loadOrderList(auxiliaryPage);
      if (!options.parentPageIsOpen()) {
        throw new Error('PRE_SUBMISSION_PARENT_PAGE_CLOSED: Generate was not attempted.');
      }
      if (auxiliaryPage.isClosed()) throw new Error('PRE_SUBMISSION_AUXILIARY_PAGE_CLOSED');

      const rowTexts = await auxiliaryPage.locator('tbody tr[role="button"]').allInnerTexts();
      return extractOrderIds(rowTexts);
    } catch {
      if (!options.parentPageIsOpen()) {
        throw new Error('PRE_SUBMISSION_PARENT_PAGE_CLOSED: Generate was not attempted.');
      }
      if (auxiliaryPage?.isClosed() && attempt === 0) continue;
      if (auxiliaryPage?.isClosed()) {
        throw new Error('PRE_SUBMISSION_AUXILIARY_PAGE_CLOSED: Existing Order IDs could not be read; Generate was not attempted.');
      }
      throw new Error('PRE_SUBMISSION_ORDER_LOOKUP_FAILED: Existing Order IDs could not be read; Generate was not attempted.');
    } finally {
      if (auxiliaryPage && !auxiliaryPage.isClosed()) await auxiliaryPage.close().catch(() => {});
    }
  }

  throw new Error('PRE_SUBMISSION_ORDER_LOOKUP_FAILED: Existing Order IDs could not be read; Generate was not attempted.');
}

export type SubmissionAttemptOptions = {
  loadKnownOrderIds: () => Promise<Set<string>>;
  ensureReady: () => void;
  onGenerateAttempt: () => void;
  clickGenerate: () => Promise<void>;
  findNewOrderId: (knownIds: Set<string>) => Promise<string>;
  onOrderIdCaptured?: (orderId: string) => void | Promise<void>;
};

export class SubmissionAttempt {
  private attempted = false;

  async run(options: SubmissionAttemptOptions): Promise<string> {
    if (this.attempted) throw new Error('DUPLICATE_SUBMISSION_BLOCKED: Generate was already attempted; do not retry.');

    const knownIds = await options.loadKnownOrderIds();
    options.ensureReady();
    this.attempted = true;
    options.onGenerateAttempt();

    let clickError = '';
    try {
      await options.clickGenerate();
    } catch (error) {
      clickError = error instanceof Error ? error.message : 'Generate click was interrupted.';
    }

    let orderId: string;
    try {
      orderId = await options.findNewOrderId(knownIds);
    } catch (error) {
      const monitorError = error instanceof Error ? error.message : 'Order ID lookup failed.';
      throw new Error(`SUBMISSION_UNCERTAIN: ${clickError ? `${clickError}; ` : ''}${monitorError} Do not retry Generate.`);
    }

    try {
      await options.onOrderIdCaptured?.(orderId);
    } catch {
      throw new Error('ORDER_ID_PERSISTENCE_FAILED: Order ID was captured but could not be persisted; do not retry Generate.');
    }
    return orderId;
  }
}
