import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ensureAuthenticated } from './auth.js';

export type OrderStatus = 'Completed'|'Failed'|'Pending'|'Unknown';
export type OrderObservation = {
  orderId: string;
  status: OrderStatus;
  observedAt: string;
  observedText: string;
  screenshotPath: string;
};

const baseURL=process.env.GXS_BASE_URL??'https://dev.beta.graphxserver.io';
const storageStatePath=path.resolve('config/auth.json');

function assertDevOnly() {
  const url=new URL(baseURL);
  if(url.protocol!=='https:'||url.hostname!=='dev.beta.graphxserver.io') {
    throw new Error('SAFETY: Order inspection is restricted to GraphXServer DEV.');
  }
}

function parseStatus(text:string):OrderStatus {
  if(/\bfailed\b|\berror\b/i.test(text)) return 'Failed';
  if(/\bcomplete(?:d)?\b/i.test(text)) return 'Completed';
  if(/\bcreated\b|\bpending\b|\bprocessing\b|\bqueued\b|\bin progress\b/i.test(text)) return 'Pending';
  return 'Unknown';
}

class OrderBrowserSession {
  private browser?:Browser;
  private context?:BrowserContext;
  private page?:Page;

  async getPage():Promise<Page> {
    if(this.browser?.isConnected()&&this.context&&!this.context.pages().every(page=>page.isClosed())&&this.page&&!this.page.isClosed()) {
      return this.page;
    }
    await this.close();
    assertDevOnly();
    this.browser=await chromium.launch();
    this.context=await this.browser.newContext({
      baseURL,
      storageState:fs.existsSync(storageStatePath)?storageStatePath:undefined
    });
    this.page=await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    await ensureAuthenticated(this.page, false, false);
    return this.page;
  }

  async close():Promise<void> {
    const context=this.context;
    const browser=this.browser;
    this.page=undefined;
    this.context=undefined;
    this.browser=undefined;
    await context?.close().catch(()=>{});
    await browser?.close().catch(()=>{});
  }
}

async function orderRow(page: Page, orderId: string) {
  await page.goto('/mockups', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('heading', { name: 'Mockup Orders' }).waitFor({ timeout: 15_000 });
  // Wait for the actual target row, not a loading label that may stay mounted.
  // The DOM may use clickable <tr> elements with or without role="button".
  const row = page.locator('tbody tr').filter({ has: page.getByText(orderId, { exact: true }) }).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 12_000 });
  } catch {
    return undefined;
  }
  return row;
}

async function saveEvidence(page:Page,orderId:string):Promise<string> {
  const safeId=orderId.replace(/[^A-Za-z0-9_-]/g,'_');
  const directory=path.resolve('reports','order-status');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${safeId}-${Date.now()}.png`);
  await page.screenshot({path:file,fullPage:true});
  return file;
}

export async function inspectOrderOnce(orderId:string):Promise<OrderObservation> {
  const session=new OrderBrowserSession();
  try {
    const page=await session.getPage();
    const row=await orderRow(page,orderId);
    if(!row) return {orderId,status:'Unknown',observedAt:new Date().toISOString(),observedText:'Order ID is not visible in the current DEV order list.',screenshotPath:''};
    const observedText=(await row.innerText()).replace(/\s+/g,' ').trim();
    let screenshotPath='';
    try { screenshotPath=await saveEvidence(page,orderId); } catch { screenshotPath=''; }
    return {orderId,status:parseStatus((await row.locator('td').nth(2).innerText()).trim()),observedAt:new Date().toISOString(),observedText,screenshotPath};
  } finally {
    await session.close();
  }
}

export async function verifyClosedPageRecovery(orderId:string):Promise<OrderObservation> {
  const session=new OrderBrowserSession();
  try {
    const originalPage=await session.getPage();
    await originalPage.goto('/mockups',{waitUntil:'domcontentloaded'});
    await originalPage.close();
    const recoveredPage=await session.getPage();
    const row=await orderRow(recoveredPage,orderId);
    if(!row) return {orderId,status:'Unknown',observedAt:new Date().toISOString(),observedText:'Order ID is not visible after closed-page recovery.',screenshotPath:''};
    const observedText=(await row.innerText()).replace(/\s+/g,' ').trim();
    let screenshotPath='';
    try { screenshotPath=await saveEvidence(recoveredPage,orderId); } catch { screenshotPath=''; }
    return {orderId,status:parseStatus((await row.locator('td').nth(2).innerText()).trim()),observedAt:new Date().toISOString(),observedText,screenshotPath};
  } finally {
    await session.close();
  }
}

export async function downloadCompletedOrder(orderId:string):Promise<string> {
  const session=new OrderBrowserSession();
  try {
    const page=await session.getPage();
    const row=await orderRow(page,orderId);
    if(!row) throw new Error(`Order ${orderId} is not visible in the DEV order list.`);
    const observedText=(await row.innerText()).replace(/\s+/g,' ').trim();
    if(parseStatus((await row.locator('td').nth(2).innerText()).trim())!=='Completed') throw new Error(`Order ${orderId} is not Completed; download was not attempted.`);
    const [download]=await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('button',{name:'Download',exact:true}).click()
    ]);
    const directory=path.resolve('reports','downloads');
    fs.mkdirSync(directory,{recursive:true});
    const safeId=orderId.replace(/[^A-Za-z0-9_-]/g,'_');
    const destination=path.join(directory,`${safeId}-${download.suggestedFilename()}`);
    await download.saveAs(destination);
    return destination;
  } finally {
    await session.close();
  }
}

export async function waitForOrder(
  orderId:string,
  options:{intervalMs:number;timeoutMs:number}
):Promise<OrderObservation> {
  if(!Number.isInteger(options.intervalMs)||options.intervalMs<1000) throw new Error('Polling interval must be at least 1000 ms.');
  if(!Number.isInteger(options.timeoutMs)||options.timeoutMs<1000) throw new Error('Polling timeout must be at least 1000 ms.');
  const session=new OrderBrowserSession();
  const deadline=Date.now()+options.timeoutMs;
  let last:OrderObservation={orderId,status:'Unknown',observedAt:new Date().toISOString(),observedText:'Order has not been observed yet.',screenshotPath:''};
  try {
    while(Date.now()<deadline) {
      try {
        const page=await session.getPage();
        const row=await orderRow(page,orderId);
        if(row) {
          const observedText=(await row.innerText()).replace(/\s+/g,' ').trim();
          last={orderId,status:parseStatus((await row.locator('td').nth(2).innerText()).trim()),observedAt:new Date().toISOString(),observedText,screenshotPath:''};
          if(last.status==='Completed'||last.status==='Failed') {
            try { last.screenshotPath=await saveEvidence(page,orderId); } catch { last.screenshotPath=''; }
            return last;
          }
        } else {
          last={orderId,status:'Unknown',observedAt:new Date().toISOString(),observedText:'Order ID is not visible in the current DEV order list.',screenshotPath:''};
        }
      } catch(error) {
        const message=error instanceof Error?error.message:'Unknown monitoring error';
        last={orderId,status:'Unknown',observedAt:new Date().toISOString(),observedText:`Monitoring interrupted: ${message}`,screenshotPath:''};
        await session.close();
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(options.intervalMs,Math.max(0,deadline-Date.now()))));
    }
    if(last.status==='Pending') return last;
    return {...last,status:'Unknown'};
  } finally {
    await session.close();
  }
}

export async function findNewOrderId(
  knownIds:Set<string>,
  options:{intervalMs:number;timeoutMs:number}
):Promise<string> {
  const session=new OrderBrowserSession();
  const deadline=Date.now()+options.timeoutMs;
  try {
    while(Date.now()<deadline) {
      const page=await session.getPage();
      await page.goto('/mockups',{waitUntil:'domcontentloaded'});
      await page.getByRole('heading',{name:'Mockup Orders'}).waitFor();
      await page.getByText('Loading Mock-ups',{exact:true}).first().waitFor({state:'hidden',timeout:30_000}).catch(()=>{});
      const rows=page.locator('tbody tr[role="button"]');
      const created:string[]=[];
      for(let index=0;index<await rows.count();index++) {
        const value=(await rows.nth(index).locator('td').first().innerText()).trim();
        if(/^MCKP-[A-Z0-9]+$/.test(value)&&!knownIds.has(value)) created.push(value);
      }
      if(created.length===1) return created[0];
      if(created.length>1) throw new Error(`SUBMISSION_UNCERTAIN: found multiple new order IDs: ${created.join(', ')}`);
      await new Promise(resolve=>setTimeout(resolve,Math.min(options.intervalMs,Math.max(0,deadline-Date.now()))));
    }
    throw new Error('SUBMISSION_UNCERTAIN: Generate was clicked but no new Order ID appeared; do not retry.');
  } finally {
    await session.close();
  }
}