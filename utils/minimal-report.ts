import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

export const RESULT_COLUMNS = ['testId','timestamp','sku','format','width','height','phase','httpStatuses','orderId','generationStatus','durationMs','outputPath','error'] as const;
export type MinimalResult = Record<(typeof RESULT_COLUMNS)[number], string>;
const FILE = path.resolve('reports','minimal-results.csv');
const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;

export function upsertMinimalResult(values: Record<string, unknown>, file = FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows: MinimalResult[] = fs.existsSync(file)
    ? parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true }) as MinimalResult[]
    : [];
  const normalized = Object.fromEntries(RESULT_COLUMNS.map(k => [k, String(values[k] ?? '')])) as MinimalResult;
  if (!normalized.testId) throw new Error('RESULT_MISSING_TEST_ID');
  const matches = rows.reduce<number[]>((acc, row, i) => row.testId === normalized.testId ? [...acc, i] : acc, []);
  const filtered = rows.filter(row => row.testId !== normalized.testId);
  if (matches.length) filtered.splice(matches[0], 0, normalized);
  else filtered.push(normalized);
  const payload = RESULT_COLUMNS.join(',') + '\n' + filtered.map(row => RESULT_COLUMNS.map(k => cell(row[k] ?? '')).join(',')).join('\n') + '\n';
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, payload, 'utf8');
  fs.renameSync(temp, file);
}
