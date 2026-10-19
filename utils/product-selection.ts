import type { MockupCase } from './config.js';

export type CatalogProduct = { sku: string; name: string };

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function selectProducts(config: MockupCase, count = config.repetitions): CatalogProduct[] {
  const catalog = config.catalogProducts;
  let candidates: CatalogProduct[];

  if (config.selectionMode === 'targeted') {
    const bySku = new Map(catalog.map(product => [product.sku, product]));
    candidates = config.targetSkus.map(sku => {
      const product = bySku.get(sku);
      if (!product) throw new Error(`Target SKU is not present in configured catalog: ${sku}`);
      return product;
    });
  } else {
    candidates = [...catalog];
  }

  if (config.selectionMode === 'random') {
    const random = seededRandom(config.selectionSeed);
    for (let index = candidates.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
    }
  }

  if (!config.allowDuplicateSkus) {
    candidates = [...new Map(candidates.map(product => [product.sku, product])).values()];
    if (count > candidates.length) throw new Error('Requested count exceeds the number of distinct available SKUs.');
    return candidates.slice(0, count);
  }

  if (candidates.length === 0) throw new Error('No products are available for selection.');
  return Array.from({ length: count }, (_, index) => candidates[index % candidates.length]);
}