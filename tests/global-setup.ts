import { chromium, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ensureAuthenticated, type SessionEvidence } from '../utils/auth.js';

export default async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const evidence: SessionEvidence = { recoveryAttempted: false, reauthenticated: false, loginAttempts: 0, organizationVerified: false, mockupsVerified: false };
  try {
    const storagePath = path.resolve('config/auth.json');
    const context = await browser.newContext({
      baseURL: config.projects[0]?.use.baseURL as string,
      storageState: fs.existsSync(storagePath) ? storagePath : undefined
    });
    const page = await context.newPage();
    const authenticatedPage = await ensureAuthenticated(page, false, true, evidence);
    if (authenticatedPage !== page) await authenticatedPage.context().close();
    await context.close();
  } finally {
    console.log(`SESSION_SETUP ${JSON.stringify(evidence)}`);
    await browser.close();
  }
}