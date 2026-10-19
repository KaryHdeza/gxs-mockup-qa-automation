import { expect, test } from '@playwright/test';
import { selectProducts } from '../utils/product-selection.js';
import type { MockupCase } from '../utils/config.js';

const config: MockupCase = {
  environment: 'https://dev.beta.graphxserver.io', productSku: 'A', productName: 'Product A', color: 'Black',
  selectionMode: 'sequential',
  catalogProducts: [{ sku: 'A', name: 'Product A' }, { sku: 'B', name: 'Product B' }, { sku: 'C', name: 'Product C' }],
  targetSkus: ['C', 'A'], selectionSeed: 42, allowDuplicateSkus: false,
  productDecorations: { A: { location: 'Front', artworkPath: '' }, B: { location: 'Back', artworkPath: '' }, C: { location: 'Side', artworkPath: '' } },
  dimensionStepsPx: [1000, 1000],
  location: 'Configured location', artworkPath: '', format: 'PNG', formatSteps: ['PNG','PNG'], widthPx: 1000, heightPx: 1000,
  layout: 'Combined', repetitions: 2, delayBetweenOrdersMs: 5000, pollIntervalMs: 10000,
  pollTimeoutMs: 30000, maxSubmissions: 1, maxExecutionTimeMs: 900000
};

test('sequential mode follows configured catalog order without duplicates', () => {
  expect(selectProducts(config).map(product => product.sku)).toEqual(['A', 'B']);
});

test('random mode is reproducible for the configured seed', () => {
  const randomConfig = { ...config, selectionMode: 'random' as const };
  expect(selectProducts(randomConfig)).toEqual(selectProducts(randomConfig));
});

test('targeted mode preserves the configured SKU list order', () => {
  const targetedConfig = { ...config, selectionMode: 'targeted' as const };
  expect(selectProducts(targetedConfig).map(product => product.sku)).toEqual(['C', 'A']);
});

test('selection fails rather than silently reusing a SKU by default', () => {
  expect(() => selectProducts(config, 4)).toThrow(/distinct available SKUs/);
});