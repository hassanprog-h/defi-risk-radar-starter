import { createAutomationService } from './automation-service.mjs';
const [selector, amount, ...destinations] = process.argv.slice(2);
const service = createAutomationService();
try {
  const job = service.start({ selector, positionUsd: Number(amount), destinations });
  while (true) {
    await new Promise(r => setTimeout(r, 500));
    const run = service.get(job.id);
    if (run.status === 'failed') throw new Error(run.error);
    if (run.status === 'complete') {
      const result = run.result;
      console.log(JSON.stringify({ mode: result.mode, sourceId: result.source.rootPositionId, blockNumber: result.source.blockNumber, assessment: result.assessment,
        allocation: result.allocation, destinationFailures: result.destinationFailures, alerts: result.alerts }, null, 2));
      break;
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { service.close(); }
