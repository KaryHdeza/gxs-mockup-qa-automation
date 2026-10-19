import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { inspectOrderOnce, downloadCompletedOrder } from '../utils/order-monitor.js';
import { verifyOutput } from '../utils/output-verification.js';
import { upsertMinimalResult } from '../utils/minimal-report.js';
import type { ExportFormat } from '../utils/config.js';

const id = process.argv[2];
if (!id || !/^MCKP-[A-Z0-9]+$/.test(id)) throw new Error('Usage: pnpm run minimal:recover -- MCKP-ORDERID');
const file = path.resolve('reports/minimal-results.csv');
if (!fs.existsSync(file)) throw new Error('Minimal CSV report does not exist. No changes made.');
const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true }) as Record<string,string>[];
const row = [...rows].reverse().find(r => r.orderId === id);
if (!row) throw new Error('Order ID is not recorded in minimal-results.csv. No changes made.');
const obs = await inspectOrderOnce(id);
row.generationStatus = obs.status;
row.phase = 'Recovered existing order';
if (obs.status === 'Completed') {
  try {
    const output = await downloadCompletedOrder(id);
    row.outputPath = output;
    await verifyOutput(output, row.format as ExportFormat, Number(row.width), Number(row.height));
    row.phase = 'Output verified';
    row.error = '';
  } catch (error) {
    row.error = `OUTPUT_VERIFICATION_FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }
} else if (obs.status === 'Failed') {
  row.error = `GENERATION_FAILED: ${id}`;
} else {
  row.error = `Status ${obs.status}; do not automatically resubmit`;
}
// Previously measured duration is preserved; no invented timestamps or duration.
upsertMinimalResult(row);
console.log(JSON.stringify({ orderId:id, status:row.generationStatus, phase:row.phase, outputVerified:row.phase==='Output verified', error:row.error }));
