import 'dotenv/config';
import { inspectOrderOnce, verifyClosedPageRecovery } from '../utils/order-monitor.js';
import { updateOrderById } from '../utils/report.js';

const args=process.argv.slice(2);
const recoveryProbe=args.includes('--verify-closed-page');
const orderId=args.find(argument=>!argument.startsWith('--'))?.trim();
if(!orderId) {
  console.error('Usage: npm run check:order -- [--verify-closed-page] <ORDER_ID>');
  process.exitCode=2;
} else {
  try {
    const observation=recoveryProbe
      ?await verifyClosedPageRecovery(orderId)
      :await inspectOrderOnce(orderId);
    let reportUpdated=false;
    if(observation.status!=='Unknown') {
      const error=observation.status==='Failed'
        ?'Order status is Failed; failure detail is not exposed in the order list.'
        :'';
      reportUpdated=updateOrderById(orderId,{
        generationStatus:observation.status,
        processingDurationMs:'',
        error,
        screenshotPath:observation.screenshotPath
      });
    }
    console.log(JSON.stringify({
      orderId:observation.orderId,
      status:observation.status,
      observedAt:observation.observedAt,
      screenshotPath:observation.screenshotPath||null,
      reportUpdated,
      closedPageRecoveryTest:recoveryProbe,
      note:observation.status==='Unknown'?observation.observedText:undefined
    },null,2));
    if(observation.status==='Unknown') process.exitCode=1;
  } catch(error) {
    const message=error instanceof Error?error.message:'Order inspection failed for an unknown reason.';
    console.error(JSON.stringify({orderId,status:'Unknown',error:message}));
    process.exitCode=1;
  }
}