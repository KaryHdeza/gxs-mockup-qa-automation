import 'dotenv/config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: process.env.AUTH_SETUP
    ? ['**/auth.setup.ts', '**/product-selection.spec.ts']
    : '**/*.spec.ts',
  timeout: 180_000, workers: 1, fullyParallel: false,
  retries: 0, reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: process.env.AUTH_SETUP ? undefined : './tests/global-setup.ts',
  outputDir: './reports/test-results',
  use: { baseURL: process.env.GXS_BASE_URL ?? 'https://dev.beta.graphxserver.io', storageState: process.env.AUTH_SETUP ? undefined : 'config/auth.json',
    screenshot: process.env.AUTH_SETUP ? 'off' : 'only-on-failure', trace: process.env.AUTH_SETUP ? 'off' : 'retain-on-failure', video: process.env.AUTH_SETUP ? 'off' : 'retain-on-failure', actionTimeout: 15_000 }
});
