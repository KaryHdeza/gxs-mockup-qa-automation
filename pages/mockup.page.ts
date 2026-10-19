import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { MockupCase } from '../utils/config.js';
import { findNewOrderId, waitForOrder } from '../utils/order-monitor.js';
import { captureExistingOrderIds, SubmissionAttempt } from '../utils/submission-lifecycle.js';

async function selectVariant(dialog: Locator, color: string | undefined, sku: string): Promise<void> {
  const variantLabel=dialog.getByText('Color variant',{exact:true});
  if(!(await variantLabel.count())) return;
  await expect(variantLabel).toBeVisible();
  const variantGroup=variantLabel.locator('xpath=..').locator('xpath=following-sibling::div[1]');
  const variantCards=variantGroup.locator('div.inline-flex.gap-medium.flex-wrap > div.group.cursor-pointer');
  await expect.poll(()=>variantCards.count(),{message:`COLOR_VARIANTS_NOT_LOADED: variants for ${sku} did not finish loading`}).toBeGreaterThan(0);
  const firstVariant=variantCards.first();
  const firstVariantSelected=()=>firstVariant.evaluate(element=>element.classList.contains('border-accent-primary'));
  if(!(await firstVariantSelected())) await firstVariant.click();
  await expect.poll(firstVariantSelected,{message:`COLOR_VARIANT_SELECTION_FAILED: first variant for ${sku} was not selected`}).toBe(true);
  const selectedColor=await variantLabel.evaluate(element=>element.parentElement?.textContent?.replace('Color variant','').trim()??'');
  if(!selectedColor) throw new Error(`COLOR_VARIANT_UNVERIFIED: the first variant for ${sku} has no visible selected color.`);
}

/**
 * SITE ADAPTER: selectors are hypotheses based on screenshots, not verified DOM.
 * Update these locators with Playwright codegen/inspector before enabling submissions.
 * Prefer roles/labels; avoid CSS classes and nth-child selectors.
 */
export class MockupPage {
 private submissionAttempt=new SubmissionAttempt();
 constructor(private page: Page) {}
 async openWizard() {
   this.submissionAttempt=new SubmissionAttempt();
   if (new URL(this.page.url()).pathname !== '/mockups') await this.page.goto('/mockups');
   try {
     await expect(this.page.getByRole('heading',{name:'Mockup Orders',exact:true})).toBeVisible();
   } catch {
     throw new Error('MOCKUPS_PAGE_LOAD_FAILED: Mockup Orders is unavailable; Generate was not attempted and no further recovery is permitted.');
   }
   await this.page.getByRole('button',{name:/\+?\s*Mockup$/i}).click();
   const orderType=this.page.getByRole('heading',{name:'New mock-up order',exact:true});
   await expect(orderType).toBeVisible();
  const orderTypeOptions=this.page.getByRole('radio');
  await expect(orderTypeOptions).toHaveCount(3);
  const singleMockup=orderTypeOptions.first();
  await expect(singleMockup).toBeVisible();
  if(!(await singleMockup.isChecked())) await singleMockup.check();
  await expect(singleMockup).toBeChecked();
   const next=this.page.getByRole('button',{name:'Next',exact:true});
   await next.waitFor({state:'visible'});
   await next.click();
   await expect(this.page.getByRole('heading',{name:'Mockup Request'})).toBeVisible();
 }
 async chooseProduct(c: MockupCase, sku = c.productSku, screenshotPath?: string) {
   // Inspect this flow using npm run inspect; catalog layout may change.
  const search=this.page.getByPlaceholder('Search by SKU or name');
  await search.fill(sku);
  const product=this.page.getByText(sku,{exact:false}).first();
  await product.waitFor({state:'visible'});
  await product.click();
  const dialog=this.page.getByRole('dialog').filter({hasText:c.productName});
  await expect(dialog.getByText(c.productName,{exact:true})).toBeVisible({timeout:30_000});
  await expect(dialog.getByText('Description',{exact:true}),'PRODUCT_DETAIL_MODAL_NOT_LOADED: product description is not visible').toBeVisible({timeout:30_000});
  await selectVariant(dialog,undefined,sku);
  if(screenshotPath) await this.page.screenshot({path:screenshotPath,fullPage:true});
  const continueButton=dialog.getByRole('button',{name:'Continue',exact:true});
  await continueButton.click();
  try {
    await expect(dialog).toBeHidden({timeout:30_000});
  } catch {
    throw new Error(`PRODUCT_DETAIL_MODAL_DID_NOT_CLOSE: Continue did not close details for ${sku}.`);
  }
  try {
    const next=this.page.getByRole('button',{name:'Next',exact:true});
    await expect(next).toBeEnabled({timeout:30_000});
    await next.click();
    await expect(this.page.getByText('Views & Locations',{exact:true})).toBeVisible({timeout:30_000});
    await expect(this.page.getByRole('dialog').getByText(sku,{exact:true}).last()).toBeVisible({timeout:30_000});
    await expect(this.page.getByText(c.productName,{exact:true})).toBeVisible({timeout:30_000});
  } catch (error) {
    const detail=error instanceof Error?error.message:String(error);
    throw new Error(`PRODUCT_SELECTION_TRANSITION_FAILED: ${sku} did not appear in Views & Locations. ${detail}`);
  }
 }
 async configureDecoration(c: MockupCase, screenshotPath?: string): Promise<string> {
  const wizard=this.page.getByRole('dialog');
  await expect(wizard.getByText('Locations',{exact:true}),'VIEWS_LOCATIONS_NOT_LOADED: location list is not visible').toBeVisible({timeout:30_000});
  const uploadButtons=wizard.locator('button:has(svg.gxs-icon-cloud-upload)');
  await expect(uploadButtons.first(),'DECORATION_LOCATION_UNAVAILABLE: no location exposes an Upload control').toBeVisible({timeout:30_000});
   const availableLocations=await uploadButtons.evaluateAll(buttons=>buttons.map(button=>{
     let node:Element|null=button;
     for(let depth=0;node&&depth<5;depth++,node=node.parentElement) {
       const label=Array.from(node.querySelectorAll('button')).find(candidate=>candidate!==button&&candidate.textContent?.trim());
       if(label) return label.textContent?.replace(/\s+/g,' ').trim()??'';
     }
     return '';
   }));
   const uploadIndex=c.location
     ?availableLocations.findIndex(location=>location.toLowerCase().includes(c.location!.toLowerCase()))
     :0;
   if(uploadIndex<0) throw new Error(`DECORATION_LOCATION_UNAVAILABLE: ${c.location} has no Upload action for ${c.productSku}.`);
   const locationName=availableLocations[uploadIndex];
   if(!locationName) throw new Error('DECORATION_LOCATION_UNVERIFIED: the upload control has no associated location name.');
   const locationButton=wizard.getByRole('button',{name:locationName,exact:true});
   await expect(locationButton).toBeVisible();
   const locationRow=locationButton.locator('xpath=../../..');
   if(!c.artworkPath) throw new Error('ARTWORK_NOT_APPLIED: no test artwork is configured.');
   const preview=wizard.locator('.konvajs-content').first();
   await expect(preview,'ARTWORK_NOT_APPLIED: product preview is not rendered').toBeVisible();
   const previewBefore=await preview.screenshot();
   const beforeImages=await locationRow.locator('img').count();
   try {
     const chooser=this.page.waitForEvent('filechooser');
     await uploadButtons.nth(uploadIndex).click();
     await (await chooser).setFiles(c.artworkPath);
     const thumbnail=locationRow.locator('img').last();
     await expect.poll(async()=>locationRow.locator('img').count(),{message:'ARTWORK_NOT_APPLIED: artwork thumbnail did not appear in the selected location',timeout:30_000}).toBeGreaterThan(beforeImages);
     await expect(thumbnail,'ARTWORK_NOT_APPLIED: artwork thumbnail is not visible in the selected location').toBeVisible();
     await expect.poll(()=>thumbnail.evaluate(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0),{message:'ARTWORK_NOT_APPLIED: uploaded thumbnail did not finish rendering',timeout:30_000}).toBe(true);
     await expect.poll(async()=>!Buffer.from(previewBefore).equals(Buffer.from(await preview.screenshot())),{message:'ARTWORK_NOT_APPLIED: artwork is not visibly rendered on the selected product view',timeout:30_000}).toBe(true);
     const artworkRequired=this.page.getByRole('alert').filter({hasText:'Artwork required'});
     if(await artworkRequired.count()) {
       await expect(artworkRequired,'ARTWORK_NOT_APPLIED: application still reports that artwork is required').toBeHidden({timeout:30_000});
     }
   } catch(error) {
     if(error instanceof Error&&error.message.startsWith('ARTWORK_NOT_APPLIED:')) throw error;
     const detail=error instanceof Error?error.message:String(error);
     throw new Error(`ARTWORK_NOT_APPLIED: upload or application confirmation failed. ${detail}`);
   }
   if(screenshotPath) await this.page.screenshot({path:screenshotPath,fullPage:true});
   const next=this.page.getByRole('button',{name:'Next',exact:true});
   await expect(next,'ARTWORK_NOT_APPLIED: application has not enabled Next').toBeEnabled();
   await next.click();
   try {
     await expect(this.page.getByText('Export options',{exact:true}),'SUMMARY_TRANSITION_FAILED: Summary did not open after decoration was applied').toBeVisible({timeout:30_000});
   } catch(error) {
     const detail=error instanceof Error?error.message:String(error);
     throw new Error(`SUMMARY_TRANSITION_FAILED: ${detail}`);
   }
   return locationName;
 }
 async setSummary(c: MockupCase): Promise<{width:number;height:number;format:string;unit:string}> {
   await expect(this.page.getByText('Export options')).toBeVisible();
   if(c.widthPx!==c.heightPx) {
     throw new Error('DIMENSION_RATIO_UNVERIFIED: DEV links width and height; unequal dimensions are not supported by this verified flow.');
   }
   const fileType=this.page.getByRole('combobox').first();
   await fileType.click();
   const formatOptions=this.page.getByRole('option');
   const availableFormats=(await formatOptions.allTextContents()).map(value=>value.trim());
   if(!availableFormats.includes(c.format)) {
     await this.page.keyboard.press('Escape');
     throw new Error(`EXPORT_FORMAT_UNAVAILABLE: ${c.format} is unavailable for ${c.productSku}; options: ${availableFormats.join(', ')}`);
   }
   await this.page.getByRole('option',{name:c.format,exact:true}).click();
   await expect(fileType).toContainText(c.format);
   const width=this.page.locator('input[id="outputSize.width"]:visible');
   const serializedWidth=this.page.locator('input[name="outputSize.width"]');
   const serializedHeight=this.page.locator('input[name="outputSize.height"]');
   await expect(width).toBeVisible();
   await expect(serializedWidth).toHaveCount(1);
   await expect(serializedHeight).toHaveCount(1);
   await width.fill(String(c.widthPx));
   await width.press('Tab');
   await expect.poll(async()=>[
     Number(await serializedWidth.inputValue()),
     Number(await serializedHeight.inputValue())
   ],{message:`DIMENSION_MISMATCH: expected ${c.widthPx} x ${c.heightPx} px after blur`})
     .toEqual([c.widthPx,c.heightPx]);
   const unit=(await this.page.getByRole('combobox').nth(1).innerText()).trim();
   if(unit!=='px') throw new Error(`DIMENSION_UNIT_MISMATCH: expected px, received ${unit}`);
   const verifiedFormat=(await fileType.innerText()).trim();
   const verifiedWidth=Number(await serializedWidth.inputValue());
   const verifiedHeight=Number(await serializedHeight.inputValue());
  if(c.layout!=='Combined') throw new Error('SUMMARY_LAYOUT_MISMATCH: the confirmed workflow requires Combined layout.');
  const combined=this.page.getByRole('radio',{name:/Combined/i});
  await expect(combined).toBeVisible();
  if(!(await combined.isChecked())) await combined.check();
  await expect(combined).toBeChecked();
   await expect(this.page.getByRole('button',{name:/Generate mock-up/i})).toBeEnabled();
   return {width:verifiedWidth,height:verifiedHeight,format:verifiedFormat,unit};
 }
 async submit(onGenerateAttempt: () => void, onOrderIdCaptured?: (orderId:string) => void | Promise<void>): Promise<string> {
   const knownIds=await captureExistingOrderIds({
     createPage:async()=>{
       if(this.page.isClosed()) throw new Error('PRE_SUBMISSION_PARENT_PAGE_CLOSED');
       return this.page.context().newPage();
     },
     loadOrderList:async auxiliaryPage=>{
       await auxiliaryPage.goto('/mockups');
       await auxiliaryPage.getByRole('heading',{name:'Mockup Orders'}).waitFor();
       await auxiliaryPage.getByText('Loading Mock-ups',{exact:true}).first().waitFor({state:'hidden',timeout:60_000});
     },
     parentPageIsOpen:()=>!this.page.isClosed()
   });

   return this.submissionAttempt.run({
     loadKnownOrderIds:async()=>knownIds,
     ensureReady:()=>{
       if(this.page.isClosed()) throw new Error('PRE_SUBMISSION_PARENT_PAGE_CLOSED: Generate was not attempted.');
     },
     onGenerateAttempt,
     clickGenerate:async()=>this.page.getByRole('button',{name:/Generate mock-up/i}).click(),
     findNewOrderId:ids=>findNewOrderId(ids,{intervalMs:2000,timeoutMs:90_000}),
     onOrderIdCaptured
   });
 }
 async pollOrder(id:string, intervalMs:number, timeoutMs:number): Promise<string> {
   const observation=await waitForOrder(id,{intervalMs,timeoutMs});
   if(observation.status==='Pending'||observation.status==='Unknown') return 'Timeout/Unknown';
   return observation.status;
 }

 async downloadCompletedOrder(id:string): Promise<string> {
   await this.page.goto('/mockups');
   await this.page.getByRole('heading',{name:'Mockup Orders'}).waitFor();
   await this.page.getByText('Loading Mock-ups',{exact:true}).first().waitFor({state:'hidden',timeout:60000}).catch(()=>{});
   const row=this.page.locator('tbody tr[role="button"]').filter({hasText:id});
   await expect(row,'Completed order must remain visible before downloading').toHaveCount(1);
   const downloadButton=row.getByRole('button',{name:'Download',exact:true});
   const [download]=await Promise.all([
     this.page.waitForEvent('download'),
     downloadButton.click()
   ]);
   const directory=path.resolve('reports','downloads');
   fs.mkdirSync(directory,{recursive:true});
   const destination=path.join(directory,`${id}-${download.suggestedFilename()}`);
   await download.saveAs(destination);
   return destination;
 }
}
