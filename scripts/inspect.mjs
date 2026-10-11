import { inspectVault } from '../dist/live/inspect.js';
import { liveOptions } from './live-config.mjs';
try {
  const selector = process.argv[2];
  if (!selector) throw new Error('Usage: npm run inspect -- <chainId>:<vault-address> [--shallow]');
  const snapshot = await inspectVault(selector, liveOptions(selector, !process.argv.includes('--shallow')));
  console.log(JSON.stringify(snapshot, null, 2));
} catch (error) {
  // Never print provider exception objects or credential-bearing RPC URLs.
  const safe = /^[A-Z_]+(?:: [a-zA-Z0-9 :<>.()-]+)?$/.test(error.message) || error.message.startsWith('Usage:') || error.message.startsWith('INVALID_SELECTOR:');
  console.error(JSON.stringify({ error: safe ? error.message : 'INSPECTION_FAILED', mode: 'live', secretsPrinted: false }));
  process.exitCode = 1;
}
