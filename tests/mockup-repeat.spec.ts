import { test, expect } from '@playwright/test';
import { loadCase, loadExecutionSettings } from '../utils/config.js';
import { MockupPage } from '../pages/mockup.page.js';
import { saveResults, type Result } from '../utils/report.js';
import { selectProducts } from '../utils/product-selection.js';
import { verifyOutput } from '../utils/output-verification.js';
import { downloadCompletedOrder, waitForOrder } from '../utils/order-monitor.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { validateArtworkFile } from '../utils/config.js';
import { CreateOrderTelemetry } from '../utils/create-order-telemetry.js';
import { MockupSession } from '../utils/auth.js';

const c=loadCase();
const execution=loadExecutionSettings(c);
const live=execution.mode==='live';

test('generate configured mockups with controlled settings', async({page: initialPage})=>{
  let page=initialPage;
  const session=new MockupSession(page);
  test.setTimeout(c.maxExecutionTimeMs+30_000);
  const selected=selectProducts(c);
  const artworkBySku=new Map<string,string>();
  for(const product of selected) {
    const decoration=c.productDecorations[product.sku];
    if(!decoration) throw new Error(`No decoration configuration exists for SKU ${product.sku}.`);
    artworkBySku.set(product.sku,validateArtworkFile(decoration.artworkPath??c.artworkPath));
  }
  const iterations=live?Math.min(execution.maxOrders,selected.length):selected.length;
  const deadline=Date.now()+c.maxExecutionTimeMs;
  const rows:Result[]=[];
  let createOrderTelemetry=new CreateOrderTelemetry(page);
  createOrderTelemetry.start();
  try {
    for(let i=0;i<iterations;i++){
      if(Date.now()>=deadline) break;
      const product=selected[i];
      const dimension=c.dimensionStepsPx[i];
      const format=c.formatSteps[i];
      const start=Date.now();
      const decoration=c.productDecorations[product.sku];
      const result:Result={
        testId:randomUUID(),productSku:product.sku,productName:product.name,decorationLocation:decoration?.location??'',
        exportFormat:format,requestedWidth:dimension,requestedHeight:dimension,verifiedWidth:'',verifiedHeight:'',
        orderId:'',submissionResult:'Not attempted',generationStatus:'Not Submitted',requestHttpStatus:'Not captured',
        processingDurationMs:'',error:'',screenshotPath:'',executionTimestamp:new Date(start).toISOString(),
        outputPath:'',detectedFormat:'',outputPixelWidth:'',outputPixelHeight:'',pdfPageWidthPt:'',pdfPageHeightPt:'',outputBytes:''
      };
      rows.push(result);
      saveResults(rows);
      let generateClicked=false;
      let processingStart:number|undefined;
      try {
        if(i===0) {
          page=await session.prepare();
          createOrderTelemetry.stop();
          createOrderTelemetry=new CreateOrderTelemetry(page);
          createOrderTelemetry.start();
        }
        const wizard=new MockupPage(page);
        if(!decoration) throw new Error(`No verified decoration configuration exists for SKU ${product.sku}.`);
        const productCase={...c,productSku:product.sku,productName:product.name,location:decoration.location,artworkPath:artworkBySku.get(product.sku)!,format,widthPx:dimension,heightPx:dimension};
        await wizard.openWizard();
        const productScreenshot=`reports/product-${i}.png`;
        await wizard.chooseProduct(productCase,product.sku,productScreenshot);
        const decorationScreenshot=`reports/decoration-${i}.png`;
        result.decorationLocation=await wizard.configureDecoration(productCase,decorationScreenshot);
        result.screenshotPath=[productScreenshot,decorationScreenshot].join(';');
        const summary=await wizard.setSummary(productCase);
        result.verifiedWidth=summary.width;
        result.verifiedHeight=summary.height;
        try {
          const screenshot=`reports/summary-${i}.png`;
          await page.screenshot({path:screenshot,fullPage:true});
          result.screenshotPath=[result.screenshotPath,screenshot].filter(Boolean).join(';');
        } catch { result.screenshotPath=''; }
        saveResults(rows);
        if(!live){
          console.log('DRY RUN: verified wizard up to Summary; no order submitted.');
        } else {
          if(Date.now()>=deadline) throw new Error('Maximum execution time reached before submission; no order was submitted.');
          processingStart=Date.now();
          const id=await wizard.submit(()=>{
            generateClicked=true;
            result.submissionResult='Generate click attempted; recovering Order ID';
            saveResults(rows);
          },capturedId=>{
            result.orderId=capturedId;
            result.submissionResult='Order ID captured';
            result.generationStatus='Pending';
            saveResults(rows);
          });

          const observation=await waitForOrder(id,{
            intervalMs:c.pollIntervalMs,
            timeoutMs:Math.min(c.pollTimeoutMs,Math.max(1000,deadline-Date.now()))
          });
          result.processingDurationMs=Date.now()-processingStart;
          result.generationStatus=observation.status;
          if(observation.screenshotPath) result.screenshotPath=observation.screenshotPath;
          if(observation.status==='Failed') {
            result.error=`GENERATION_FAILED: ${id} is Failed in the DEV orders UI.`;
          } else if(observation.status==='Pending') {
            result.error=`GENERATION_TIMEOUT: ${id} remained Pending for the configured timeout.`;
          } else if(observation.status==='Unknown') {
            result.error=`MONITORING_UNKNOWN: ${observation.observedText}`;
          } else {
            result.outputPath=await downloadCompletedOrder(id);
            const output=await verifyOutput(result.outputPath,format,dimension,dimension);
            result.detectedFormat=output.detectedFormat;
            result.outputPixelWidth=output.width??'';
            result.outputPixelHeight=output.height??'';
            result.pdfPageWidthPt=output.pdfPageWidthPt??'';
            result.pdfPageHeightPt=output.pdfPageHeightPt??'';
            result.outputBytes=output.fileBytes;
          }
        }
      } catch(e){
        result.error=e instanceof Error?e.message:String(e);
        if(generateClicked && !result.orderId) {
          result.generationStatus='Submission Uncertain';
          result.submissionResult='Uncertain; no automatic retry';
        } else if(!generateClicked) {
          result.generationStatus='Automation Error';
        } else if(result.generationStatus==='Pending') {
          result.generationStatus='Monitoring Error';
        }
        if(processingStart!==undefined) result.processingDurationMs=Date.now()-processingStart;
        result.screenshotPath='';
        try {
          const screenshot=`reports/error-${i}.png`;
          await page.screenshot({path:screenshot,fullPage:true});
          result.screenshotPath=screenshot;
        } catch { result.screenshotPath=''; }
        console.error(`Iteration ${i}: ${result.error}`);
        // Stop on selector/automation errors to prevent accidental duplicate orders.
      }
      saveResults(rows);
      if(result.error&&(!live||!['Completed','Failed'].includes(result.generationStatus))) break;
      if(i<iterations-1) await page.waitForTimeout(Math.min(c.delayBetweenOrdersMs,Math.max(0,deadline-Date.now())));
    }
  } finally {
    createOrderTelemetry.stop();
    console.log(`SESSION_VALIDATION ${JSON.stringify(session.evidence)}`);
    await test.info().attach('session-validation',{body:JSON.stringify(session.evidence),contentType:'application/json'});
    const snapshot=createOrderTelemetry.snapshot();
    fs.writeFileSync(`reports/create-order-telemetry-${rows[0]?.testId??'empty'}.json`,JSON.stringify(snapshot,null,2));
    if(!live) expect(snapshot.distinctRequestCount,'Dry-run must not call orders.createOrder').toBe(0);
    saveResults(rows);
    await session.close();
  }
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(r=>!r.error), `MOCKUP_WORKFLOW_FAILED: ${rows.filter(r=>r.error).map(r=>r.error).join(' | ')}`).toBeTruthy();
});
