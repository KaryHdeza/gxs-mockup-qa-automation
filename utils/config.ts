import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from 'image-size';
export type ExportFormat = 'PNG' | 'JPG' | 'JPEG' | 'WEBP' | 'PDF';
export type MockupCase = {
  environment: string; productSku: string; productName: string; color?: string;
  selectionMode: 'sequential'|'random'|'targeted'; catalogProducts: { sku: string; name: string }[];
  targetSkus: string[]; selectionSeed: number; allowDuplicateSkus: boolean;
  productDecorations: Record<string, { location?: string; artworkPath?: string }>;
  dimensionStepsPx: number[];
  location?: string; artworkPath: string; format: ExportFormat; formatSteps: ExportFormat[];
  widthPx: number; heightPx: number; layout: 'Combined'|'Individual';
  repetitions: number; delayBetweenOrdersMs: number; pollIntervalMs: number;
  pollTimeoutMs: number; maxSubmissions: number; maxExecutionTimeMs: number;
};
export type ExecutionSettings = { mode: 'dry-run'|'live'; maxOrders: number };

export function validateArtworkFile(filePath: string): string {
 const resolvedPath=path.resolve(filePath);
 if(path.extname(resolvedPath).toLowerCase()!=='.png') throw new Error(`ARTWORK_FORMAT_UNSUPPORTED: ${filePath} must use the .png extension.`);
 if(!fs.existsSync(resolvedPath)||!fs.statSync(resolvedPath).isFile()) throw new Error(`ARTWORK_FILE_MISSING: ${filePath}`);
 const bytes=fs.readFileSync(resolvedPath);
 if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error(`ARTWORK_FORMAT_UNSUPPORTED: ${filePath} is not a PNG file.`);
 const image=imageSize(bytes);
 if(image.type!=='png'||!image.width||!image.height) throw new Error(`ARTWORK_INVALID: ${filePath} is not a supported PNG image.`);
 return resolvedPath;
}

export function loadCase(): MockupCase {
 const c = JSON.parse(fs.readFileSync('config/cases.json','utf8')) as MockupCase;
 const baseUrl = process.env.GXS_BASE_URL ?? c.environment;
 if(c.environment !== 'https://dev.beta.graphxserver.io' || baseUrl !== c.environment) throw new Error('SAFETY: Only GXS DEV is permitted');
 for(const x of [c.widthPx,c.heightPx,c.repetitions,c.maxSubmissions,c.maxExecutionTimeMs]) if(!Number.isInteger(x) || x<=0) throw new Error('Invalid numeric configuration');
 if(c.dimensionStepsPx.length!==c.repetitions || c.dimensionStepsPx.some(x=>!Number.isInteger(x) || x<=0)) throw new Error('Dimension steps must provide one positive integer per mockup.');
 if(c.formatSteps.length!==c.repetitions || c.formatSteps.some(format=>!['PNG','JPG','WEBP','PDF'].includes(format))) throw new Error('Format steps must provide a supported export format per mockup.');
 if(c.pollIntervalMs<2000 || c.delayBetweenOrdersMs<1000 || c.pollTimeoutMs<10000) throw new Error('SAFETY: polling/delay is too aggressive');
 if(!c.productSku) throw new Error('A product SKU is required');
 if(!['sequential','random','targeted'].includes(c.selectionMode)) throw new Error('Invalid product selection mode');
 if(!Number.isInteger(c.selectionSeed) || c.catalogProducts.length===0) throw new Error('A catalog product list and integer seed are required');
 if(c.catalogProducts.some(product=>!product.sku || !product.name)) throw new Error('Catalog entries require a SKU and product name');
 if(c.selectionMode==='targeted' && c.targetSkus.length===0) throw new Error('Targeted mode requires at least one target SKU');
 if(!c.productDecorations || typeof c.productDecorations!=='object') throw new Error('Per-product decoration settings are required');
 return c;
}

export function loadExecutionSettings(config: MockupCase): ExecutionSettings {
 const mode=process.env.GXS_EXECUTION_MODE ?? 'dry-run';
 if(mode!=='dry-run' && mode!=='live') throw new Error('GXS_EXECUTION_MODE must be dry-run or live.');
 if(mode==='dry-run') return {mode,maxOrders:0};
 if(process.env.ALLOW_SUBMIT!=='true' || process.env.APPROVE_SUBMISSIONS!=='true' || process.env.SELECTORS_VERIFIED!=='true') {
   throw new Error('SAFETY: Live mode requires ALLOW_SUBMIT, APPROVE_SUBMISSIONS, and SELECTORS_VERIFIED to be true.');
 }
 const maxOrders=Number(process.env.GXS_MAX_ORDERS);
 if(!Number.isSafeInteger(maxOrders) || maxOrders<1) throw new Error('SAFETY: Live mode requires a positive GXS_MAX_ORDERS limit.');
 if(maxOrders>config.maxSubmissions || maxOrders>config.repetitions) throw new Error('SAFETY: GXS_MAX_ORDERS exceeds the configured submission limit or run plan.');
 if(maxOrders>1 && process.env.APPROVE_MULTIPLE_SUBMISSIONS!=='true') throw new Error('SAFETY: More than one order requires explicit batch approval.');
 return {mode,maxOrders};
}
