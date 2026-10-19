
import fs from 'node:fs';
import path from 'node:path';
import { verifyOutput } from '../utils/output-verification.js';

async function main() {
  const directory = path.resolve('reports/downloads');
  const orderId = 'MCKP-I5Z1A03KETZL';

  const file = fs.readdirSync(directory).find(
    name =>
      name.startsWith(orderId) &&
      /\.jpe?g$/i.test(name)
  );

  if (!file) {
    throw new Error(`JPEG_NOT_FOUND: ${orderId}`);
  }

  const filePath = path.join(directory, file);

  const result = await verifyOutput(
    filePath,
    'JPEG',
    2000,
    2000
  );

  console.log('OUTPUT VALIDATION: PASS');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(
    'OUTPUT VALIDATION: FAIL',
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
