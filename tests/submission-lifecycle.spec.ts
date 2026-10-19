import { test, expect, type Page } from '@playwright/test';
import { captureExistingOrderIds, SubmissionAttempt } from '../utils/submission-lifecycle.js';

const orderRows = '<table><tbody><tr role="button"><td>MCKP-ABC123</td></tr><tr role="button"><td>MCKP-XYZ789</td></tr></tbody></table>';

async function addClickCounter(button: ReturnType<Page['getByRole']>): Promise<void> {
  await button.evaluate(element => {
    element.setAttribute('data-clicks', '0');
    element.addEventListener('click', () => {
      element.setAttribute('data-clicks', String(Number(element.getAttribute('data-clicks')) + 1));
    });
  });
}

test('captures existing Order IDs and closes the auxiliary page', async ({ page }) => {
  let auxiliaryPage: Page | undefined;
  const knownIds = await captureExistingOrderIds({
    createPage: async () => {
      auxiliaryPage = await page.context().newPage();
      return auxiliaryPage;
    },
    loadOrderList: async orderPage => orderPage.setContent(orderRows),
    parentPageIsOpen: () => !page.isClosed()
  });

  expect([...knownIds]).toEqual(['MCKP-ABC123', 'MCKP-XYZ789']);
  expect(auxiliaryPage?.isClosed()).toBe(true);
});

test('closes the auxiliary page when order-list loading fails', async ({ page }) => {
  let auxiliaryPage: Page | undefined;
  await expect(captureExistingOrderIds({
    createPage: async () => {
      auxiliaryPage = await page.context().newPage();
      return auxiliaryPage;
    },
    loadOrderList: async () => { throw new Error('local fixture failure'); },
    parentPageIsOpen: () => !page.isClosed()
  })).rejects.toThrow('PRE_SUBMISSION_ORDER_LOOKUP_FAILED');

  expect(auxiliaryPage?.isClosed()).toBe(true);
});

test('recovers once when the auxiliary page closes during lookup', async ({ page }) => {
  let createCount = 0;
  const auxiliaryPages: Page[] = [];
  const knownIds = await captureExistingOrderIds({
    createPage: async () => {
      createCount++;
      const auxiliaryPage = await page.context().newPage();
      auxiliaryPages.push(auxiliaryPage);
      return auxiliaryPage;
    },
    loadOrderList: async auxiliaryPage => {
      if (createCount === 1) {
        await auxiliaryPage.setContent(orderRows);
        await auxiliaryPage.close();
        return;
      }
      await auxiliaryPage.setContent(orderRows);
    },
    parentPageIsOpen: () => !page.isClosed()
  });

  expect(createCount).toBe(2);
  expect([...knownIds]).toEqual(['MCKP-ABC123', 'MCKP-XYZ789']);
  expect(auxiliaryPages.every(auxiliaryPage => auxiliaryPage.isClosed())).toBe(true);
});

test('blocks Generate when the pre-submission lookup fails', async ({ page }) => {
  await page.setContent('<button>Generate mock-up</button>');
  const generateButton = page.getByRole('button', { name: 'Generate mock-up' });
  await addClickCounter(generateButton);
  const attempt = new SubmissionAttempt();

  await expect(attempt.run({
    loadKnownOrderIds: async () => { throw new Error('PRE_SUBMISSION_ORDER_LOOKUP_FAILED'); },
    ensureReady: () => {},
    onGenerateAttempt: () => {},
    clickGenerate: () => generateButton.click(),
    findNewOrderId: async () => 'MCKP-NEW123'
  })).rejects.toThrow('PRE_SUBMISSION_ORDER_LOOKUP_FAILED');

  await expect(generateButton).toHaveAttribute('data-clicks', '0');
});

test('persists the captured Order ID and blocks duplicate Generate actions', async ({ page }) => {
  await page.setContent('<button>Generate mock-up</button>');
  const generateButton = page.getByRole('button', { name: 'Generate mock-up' });
  await addClickCounter(generateButton);
  const attempt = new SubmissionAttempt();
  const sequence: string[] = [];
  const options = {
    loadKnownOrderIds: async () => { sequence.push('lookup'); return new Set(['MCKP-OLD123']); },
    ensureReady: () => { sequence.push('ready'); },
    onGenerateAttempt: () => { sequence.push('attempt'); },
    clickGenerate: async () => { sequence.push('click'); await generateButton.click(); },
    findNewOrderId: async (knownIds: Set<string>) => {
      expect(knownIds.has('MCKP-OLD123')).toBe(true);
      sequence.push('id-found');
      return 'MCKP-NEW123';
    },
    onOrderIdCaptured: async (orderId: string) => { sequence.push(`persist:${orderId}`); }
  };

  await expect(attempt.run(options)).resolves.toBe('MCKP-NEW123');
  await expect(attempt.run(options)).rejects.toThrow('DUPLICATE_SUBMISSION_BLOCKED');

  expect(sequence).toEqual(['lookup', 'ready', 'attempt', 'click', 'id-found', 'persist:MCKP-NEW123']);
  await expect(generateButton).toHaveAttribute('data-clicks', '1');
});
