import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
export type Result = {
	testId: string; productSku: string; productName: string; decorationLocation: string; exportFormat: string;
	requestedWidth: number; requestedHeight: number; verifiedWidth: number | ''; verifiedHeight: number | '';
	orderId: string; submissionResult: string; generationStatus: string; requestHttpStatus: string;
	processingDurationMs: number | ''; error: string; screenshotPath: string; executionTimestamp: string;
	outputPath: string; detectedFormat: string; outputPixelWidth: number | ''; outputPixelHeight: number | '';
	pdfPageWidthPt: number | ''; pdfPageHeightPt: number | ''; outputBytes: number | '';
};
const quote=(s:unknown)=>'"'+String(s??'').replaceAll('"','""')+'"';
let writtenRows=0;
let schemaInitialized=false;

const cols: (keyof Result)[]=[
	'testId','productSku','productName','decorationLocation','exportFormat','requestedWidth','requestedHeight',
	'verifiedWidth','verifiedHeight','orderId','submissionResult','generationStatus','requestHttpStatus',
	'processingDurationMs','error','screenshotPath','executionTimestamp','outputPath','detectedFormat',
	'outputPixelWidth','outputPixelHeight','pdfPageWidthPt','pdfPageHeightPt','outputBytes'
];

function ensureSchema(file:string) {
	if(schemaInitialized) return;
	if(!fs.existsSync(file)) { schemaInitialized=true; return; }
	const parsed=parse(fs.readFileSync(file,'utf8'),{skip_empty_lines:true}) as string[][];
	const oldHeader=parsed.shift()??[];
	if(JSON.stringify(oldHeader)===JSON.stringify(cols)) { schemaInitialized=true; return; }
	const indexes=new Map(oldHeader.map((column,index)=>[column,index]));
	const oldValue=(row:string[],...names:string[])=>{
		for(const name of names) {
			const index=indexes.get(name);
			if(index!==undefined && row[index]!==undefined) return row[index];
		}
		return '';
	};
	const migrated=parsed.map(row=>{
		const orderId=oldValue(row,'orderId');
		const status=oldValue(row,'generationStatus','status');
		const values:Record<keyof Result,unknown>={
			testId:oldValue(row,'testId'),productSku:oldValue(row,'productSku','sku'),productName:oldValue(row,'productName'),
			decorationLocation:oldValue(row,'decorationLocation'),exportFormat:oldValue(row,'exportFormat','format'),
			requestedWidth:oldValue(row,'requestedWidth','width'),requestedHeight:oldValue(row,'requestedHeight','height'),
			verifiedWidth:oldValue(row,'verifiedWidth'),verifiedHeight:oldValue(row,'verifiedHeight'),orderId,
			submissionResult:oldValue(row,'submissionResult')||(orderId?'Historical order ID recorded':status==='Not Submitted'?'Not attempted':'Unknown historical outcome'),
			generationStatus:status||'Unknown',requestHttpStatus:oldValue(row,'requestHttpStatus')||'Not captured',
			processingDurationMs:oldValue(row,'processingDurationMs','durationMs'),error:oldValue(row,'error'),
			screenshotPath:oldValue(row,'screenshotPath','evidence'),executionTimestamp:oldValue(row,'executionTimestamp'),
			outputPath:oldValue(row,'outputPath'),detectedFormat:oldValue(row,'detectedFormat'),
			outputPixelWidth:oldValue(row,'outputPixelWidth'),outputPixelHeight:oldValue(row,'outputPixelHeight'),
			pdfPageWidthPt:oldValue(row,'pdfPageWidthPt'),pdfPageHeightPt:oldValue(row,'pdfPageHeightPt'),outputBytes:oldValue(row,'outputBytes')
		};
		return cols.map(column=>quote(values[column])).join(',');
	});
	fs.writeFileSync(file,[cols.join(','),...migrated].join('\n')+'\n');
	schemaInitialized=true;
}

export function saveResults(rows: Result[]) {
 fs.mkdirSync('reports',{recursive:true});
 const file='reports/mockup-results.csv';
	ensureSchema(file);
 const existing=fs.existsSync(file)
	 ?parse(fs.readFileSync(file,'utf8'),{columns:true,skip_empty_lines:true}) as Record<string,string>[]
	 :[];
 const byTestId=new Map(existing.map((row,index)=>[row.testId,index]));
 for(const result of rows) {
	 const record=Object.fromEntries(cols.map(column=>[column,String(result[column]??'')])) as Record<string,string>;
	 const previousIndex=byTestId.get(result.testId);
	 if(previousIndex===undefined) {
		 byTestId.set(result.testId,existing.length);
		 existing.push(record);
	 } else {
		 existing[previousIndex]=record;
	 }
 }
 const lines=[cols.join(','),...existing.map(row=>cols.map(column=>quote(row[column])).join(','))];
 fs.writeFileSync(file,lines.join('\n')+'\n');
 writtenRows=rows.length;
 console.log(`Results written to ${file}`);
}

export function updateOrderById(orderId:string,updates:Partial<Result>):boolean {
 const file='reports/mockup-results.csv';
 ensureSchema(file);
 if(!fs.existsSync(file)) return false;
 const existing=parse(fs.readFileSync(file,'utf8'),{columns:true,skip_empty_lines:true}) as Record<string,string>[];
 const row=existing.find(result=>result.orderId===orderId);
 if(!row) return false;
 for(const [key,value] of Object.entries(updates)) {
	 if(cols.includes(key as keyof Result)) row[key]=String(value??'');
 }
 fs.writeFileSync(file,[cols.join(','),...existing.map(result=>cols.map(column=>quote(result[column])).join(','))].join('\n')+'\n');
 return true;
}
