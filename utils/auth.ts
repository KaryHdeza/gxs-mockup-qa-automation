import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

const baseUrl = process.env.GXS_BASE_URL ?? 'https://dev.beta.graphxserver.io';
const storagePath = path.resolve('config/auth.json');
const organization = 'Doe Test org-2';
const pageLoadFailure = /This page couldn['\u2019]t load/i;

type AuthDiagnostics = {
  stage: string;
  hostname: string;
  pathname: string;
  redirectCount: number;
  navigationErrorCategory: string;
};

function safeLocation(value: string) {
  try {
    const url = new URL(value);
    const pathname = ['/', '/dashboard', '/sign-in', '/select-organization'].includes(url.pathname)
      ? url.pathname : '/[redacted]';
    return { hostname: url.hostname, pathname };
  } catch {
    return { hostname: '', pathname: '' };
  }
}

function safeOriginalError(error: unknown): Error {
  const original = error instanceof Error ? error : new Error('Non-Error authentication exception');
  const sanitize = (text: string) => {
    for (const secret of [process.env.GXS_EMAIL, process.env.GXS_PASSWORD]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text
      .replace(/https?:\/\/[^\s"'<>]+/g, value => {
        const location = safeLocation(value);
        return `${location.hostname}${location.pathname}`;
      })
      .replace(/^.*(?:authorization|cookie|bearer|client_secret|code_verifier).*$/gim, '[sensitive detail redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[redacted]')
      .replace(/(["'])(.*?)\1/g, (_match, quote: string, value: string) =>
        `${quote}${['Email address', 'Password', 'Log in', 'Get Started', 'Dashboard', organization].includes(value) ? value : '[redacted]'}${quote}`);
  };
  const message = sanitize(original.message.split('\nCall log:')[0]);
  const safe = new Error(message);
  safe.name = original.name === 'TimeoutError' ? 'TimeoutError' : 'Error';
  const frames = (original.stack ?? '').split('\n').filter(line => /^\s+at\s/.test(line));
  safe.stack = `${safe.name}: ${message}\n${frames.map(sanitize).join('\n')}`;
  return safe;
}

async function authenticationFailure(page: Page, error: unknown, diagnostics: AuthDiagnostics): Promise<Error> {
  const cause = safeOriginalError(error);
  const message = error instanceof Error ? error.message : '';
  const navigationError = /net::ERR_[A-Z_]+/.exec(message)?.[0];
  if (navigationError) diagnostics.navigationErrorCategory = navigationError;
  let code = 'AUTH_LOGIN_FAILED';
  if (diagnostics.navigationErrorCategory === 'net::ERR_TOO_MANY_REDIRECTS') code = 'AUTH_REDIRECT_LOOP';
  else if (diagnostics.stage === 'login-form-readiness') code = 'AUTH_FORM_UNAVAILABLE';
  else if (/^(dashboard-|organization-verification)/.test(diagnostics.stage)) code = 'AUTH_DASHBOARD_UNAVAILABLE';
  console.error(`AUTH_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
  try {
    const directory = path.resolve('reports', 'auth-diagnostics');
    fs.mkdirSync(directory, { recursive: true });
    const artifact = path.join(directory, `auth-failure-${Date.now()}`);
    fs.writeFileSync(`${artifact}.json`, JSON.stringify({ ...diagnostics, code, error: { message: cause.message, stack: cause.stack } }, null, 2));
    if (!page.isClosed()) {
      const masks = [page.locator('input, textarea, [contenteditable], pre, code'),
        page.getByText(/https?:\/\/|@|\beyJ[A-Z0-9_-]+|authorization|cookie|token/i)];
      for (const secret of [process.env.GXS_EMAIL, process.env.GXS_PASSWORD]) {
        if (secret) masks.push(page.getByText(secret, { exact: false }));
      }
      await page.screenshot({ path: `${artifact}.png`, fullPage: true, mask: masks, timeout: 5000 });
    }
  } catch {
    console.error('AUTH_DIAGNOSTIC_ARTIFACT_UNAVAILABLE');
  }
  return new Error(`${code}: stage=${diagnostics.stage}; ${cause.message}`, { cause });
}

export type SessionEvidence = {
  recoveryAttempted: boolean;
  reauthenticated: boolean;
  loginAttempts: number;
  organizationVerified: boolean;
  mockupsVerified: boolean;
};

function assertDevUrl() {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'dev.beta.graphxserver.io') {
    throw new Error('SAFETY: Authentication is restricted to GraphXServer DEV.');
  }
}

async function failOnInteractiveChallenge(page: Page) {
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/captcha|two[- ]factor|multi[- ]factor|verification code|security challenge|authenticator|one[- ]time (?:code|password)/.test(body)) {
    throw new Error('Authentication requires an interactive security challenge; automation stopped without bypassing it.');
  }
}

async function selectOrganizationIfPrompted(page: Page, diagnostics: AuthDiagnostics) {
  const url = new URL(page.url());
  if (url.hostname !== 'dev.auth.graphxserver.io' || !url.pathname.includes('select-organization')) return false;

  diagnostics.stage = 'organization-selection-before-click';
  const workspaceCard = page.getByRole('button').filter({
    has: page.getByRole('heading', { name: organization, exact: true, level: 3 })
  });
  await expect(workspaceCard).toHaveCount(1);
  await expect(workspaceCard).toBeVisible({ timeout: 30_000 });
  await expect(workspaceCard).toBeEnabled({ timeout: 30_000 });
  await workspaceCard.click({ trial: true });
  diagnostics.stage = 'organization-selection-click';
  await workspaceCard.click();
  diagnostics.stage = 'organization-selection-after-click';
  await page.waitForURL(next => next.origin === 'https://dev.beta.graphxserver.io', { timeout: 30_000 });
  await expect(page.getByText(organization, { exact: true })).toBeVisible({ timeout: 30_000 });
  return true;
}

async function verifyDashboard(page: Page, diagnostics?: AuthDiagnostics): Promise<boolean> {
  try {
    if (diagnostics) diagnostics.stage = 'dashboard-navigation';
    await page.goto(`${baseUrl}/dashboard`);
    if (diagnostics) diagnostics.stage = 'dashboard-readiness';
    await expect(page).toHaveURL(url => url.origin === baseUrl && url.pathname === '/dashboard', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /dashboard/i }).or(page.getByRole('link', { name: 'Dashboard', exact: true })).first()).toBeVisible({ timeout: 15_000 });
    if (diagnostics) diagnostics.stage = 'organization-verification';
    await expect(page.getByText(organization, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    if (await page.getByRole('heading', { name: pageLoadFailure }).isVisible()) throw new Error('Dashboard displays the page-load failure heading.');
    return true;
  } catch (error) {
    if (diagnostics) throw error;
    return false;
  }
}

export async function ensureAuthenticated(page: Page, force = false, allowLogin = true, evidence?: SessionEvidence): Promise<Page> {
  assertDevUrl();
  if (!force && await verifyDashboard(page)) {
    if (evidence) evidence.organizationVerified = true;
    return page;
  }
  if (!allowLogin) throw new Error('AUTH_SESSION_INVALID: read-only monitoring cannot reauthenticate after Generate.');
  const browser = page.context().browser();
  if (!browser) throw new Error('AUTH_BROWSER_REQUIRED');
  const context = await browser.newContext({ baseURL: baseUrl });
  const freshPage = await context.newPage();
  const diagnostics: AuthDiagnostics = { stage: 'app-entry-navigation', hostname: '', pathname: '', redirectCount: 0, navigationErrorCategory: 'none' };
  freshPage.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === freshPage.mainFrame()) {
      Object.assign(diagnostics, safeLocation(request.url()));
      if (request.redirectedFrom()) diagnostics.redirectCount++;
    }
  });
  freshPage.on('requestfailed', request => {
    if (request.isNavigationRequest() && request.frame() === freshPage.mainFrame()) {
      diagnostics.navigationErrorCategory = /net::ERR_[A-Z_]+/.exec(request.failure()?.errorText ?? '')?.[0] ?? 'navigation-failed';
    }
  });
  try {
    await login(freshPage, diagnostics, evidence);
    if (!await verifyDashboard(freshPage, diagnostics)) throw new Error('AUTH_DASHBOARD_UNAVAILABLE');
    if (evidence) evidence.organizationVerified = true;
    diagnostics.stage = 'storage-state-save';
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    await context.storageState({ path: storagePath });
    return freshPage;
  } catch (error) {
    const failure = await authenticationFailure(freshPage, error, diagnostics);
    await context.close().catch(() => {});
    throw failure;
  }
}

async function login(page: Page, diagnostics: AuthDiagnostics, evidence?: SessionEvidence) {
  const email = process.env.GXS_EMAIL;
  const password = process.env.GXS_PASSWORD;

  const emailField = page.getByRole('textbox', { name: 'Email address' });
  const passwordField = page.getByRole('textbox', { name: 'Password' });
  const getStarted = page.getByRole('link', { name: 'Get Started', exact: true });
  await page.goto(`${baseUrl}/`);
  diagnostics.stage = 'login-entry-readiness';
  await expect.poll(async () =>
    (await emailField.isVisible() && await passwordField.isVisible()) || await getStarted.isVisible(),
  { timeout: 30_000 }).toBe(true);
  if (!(await emailField.isVisible() && await passwordField.isVisible())) {
    diagnostics.stage = 'login-entry-click';
    await getStarted.click();
  }

  diagnostics.stage = 'login-form-readiness';
  {
    await failOnInteractiveChallenge(page);
    if (!email || !password) {
      throw new Error('GXS_EMAIL and GXS_PASSWORD must be set in the ignored .env file.');
    }
    await emailField.waitFor({ state: 'visible', timeout: 30_000 });
    await passwordField.waitFor({ state: 'visible', timeout: 30_000 });
    if (new URL(page.url()).hostname !== 'dev.auth.graphxserver.io'
      || new URL(page.url()).protocol !== 'https:'
      || !await emailField.isVisible() || !await passwordField.isVisible()) {
      throw new Error('The DEV identity provider did not expose the expected email/password login form.');
    }

    if (evidence) evidence.loginAttempts++;
    diagnostics.stage = 'email-fill';
    await emailField.fill(email);
    diagnostics.stage = 'password-fill';
    await passwordField.fill(password);
    diagnostics.stage = 'login-submit';
    await page.getByRole('button', { name: 'Log in', exact: true }).click();

    diagnostics.stage = 'login-redirect';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await failOnInteractiveChallenge(page);
      if (await selectOrganizationIfPrompted(page, diagnostics)) continue;
      if (new URL(page.url()).hostname === 'dev.beta.graphxserver.io'
        && !(await emailField.isVisible().catch(() => false))) break;
      await page.waitForTimeout(500);
    }
    if (new URL(page.url()).hostname !== 'dev.beta.graphxserver.io'
      || await emailField.isVisible().catch(() => false)) {
      throw new Error('Automated authentication did not complete; check account access or security requirements.');
    }
    if (evidence) evidence.reauthenticated = true;
  }
}

export class MockupSession {
  readonly evidence: SessionEvidence = { recoveryAttempted: false, reauthenticated: false, loginAttempts: 0, organizationVerified: false, mockupsVerified: false };
  private readonly freshPages: Page[] = [];
  private started = false;

  constructor(private page: Page) {}

  private async authenticate(force = false) {
    const authenticated = await ensureAuthenticated(this.page, force, true, this.evidence);
    if (authenticated !== this.page) this.freshPages.push(authenticated);
    this.page = authenticated;
  }

  private async openOrders(): Promise<boolean> {
    try {
      await this.page.goto(`${baseUrl}/mockups`);
      await expect(this.page.getByRole('heading', { name: 'Mockup Orders', exact: true })
        .or(this.page.getByRole('heading', { name: pageLoadFailure })).first()).toBeVisible({ timeout: 30_000 });
      if (new URL(this.page.url()).origin !== baseUrl || await this.page.getByRole('heading', { name: pageLoadFailure }).isVisible()) return false;
      await expect(this.page.getByText(organization, { exact: true }).first()).toBeVisible();
      await expect(this.page.getByRole('button', { name: /Mockup$/i })).toBeVisible();
      return true;
    } catch {
      return false;
    }
  }

  async prepare(): Promise<Page> {
    if (this.started) throw new Error('SESSION_RECOVERY_BLOCKED: preparation can only run once before the wizard.');
    this.started = true;
    await this.authenticate();
    if (!await this.openOrders()) {
      this.evidence.recoveryAttempted = true;
      await this.authenticate(true);
      if (!await this.openOrders()) throw new Error('MOCKUPS_PAGE_LOAD_FAILED: persists after one session recovery; cause is not confirmed as authentication.');
    }
    this.evidence.mockupsVerified = true;
    return this.page;
  }

  async close() {
    await Promise.all(this.freshPages.map(page => page.context().close()));
  }
}