import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSafeProposal } from '../dist/automation/proposal.js';
import { ReadOnlyRpc } from '../dist/connectors/rpc.js';
import { simulateSafeProposal } from './safe-proposal-sim.mjs';
import './live-config.mjs'; // loads .env

/** Prepare, then fork-simulate. The batch is only returned as usable when the simulation passed. */
export async function runSafeProposal({ source, destination, safe, shares, moveFraction, toleranceBps, plan }) {
  if (!process.env.ETHEREUM_RPC_URL) throw new Error('ETHEREUM_RPC_NOT_CONFIGURED');
  const rpc = new ReadOnlyRpc(process.env.ETHEREUM_RPC_URL, 1, 200);
  const proposal = await prepareSafeProposal({ rpc, chainId: 1, source, destination, safe, shares, moveFraction, toleranceBps, plan });
  const simulation = await simulateSafeProposal(proposal);
  const passed = simulation.status === 'SIMULATION_PASSED';
  return { proposal: { ...proposal, status: passed ? 'READY_TO_SIGN' : 'NOT_EXECUTABLE', simulation }, batch: passed ? proposal.batch : null };
}

const SAFE_ERRORS = /^(ETHEREUM_RPC_NOT_CONFIGURED|UNSUPPORTED_CHAIN|INVALID_[A-Z_]+|SOURCE_EQUALS_DESTINATION|AMBIGUOUS_SIZE|SIZE_REQUIRED|PLAN_SOURCE_MISMATCH|DESTINATION_NOT_PROPOSED|OWNER_IS_NOT_A_[A-Z_]+|BUNDLER3_ROUTE_NOT_VERIFIED|VAULT_HAS_NO_CODE|NOT_AN_ERC4626_VAULT|UNDERLYING_ASSET_MISMATCH|INSUFFICIENT_SHARES|ZERO_PREVIEW|PRICE_BOUND_UNDERFLOW|ANCHOR_REORGED|PROVIDER_UNAVAILABLE|INVALID_OUTSIDER|ANVIL_[A-Z_]+)/;
export const publicError = error => SAFE_ERRORS.test(error?.message ?? '') ? error.message : 'PROPOSAL_UNAVAILABLE';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const [source, destination, safe] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  try {
    if (!source || !destination || !safe) throw new Error('Usage: npm run propose -- <source-vault> <destination-vault> <safe> (--shares RAW | --fraction 0..1) [--tolerance-bps 50] [--out .radar/proposals]');
    const fraction = flag('--fraction');
    const result = await runSafeProposal({ source, destination, safe, shares: flag('--shares'), moveFraction: fraction === undefined ? undefined : Number(fraction), toleranceBps: flag('--tolerance-bps') === undefined ? undefined : Number(flag('--tolerance-bps')) });
    const { proposal } = result;
    const stamp = proposal.anchor.number;
    const out = resolve(flag('--out') ?? '.radar/proposals');
    await mkdir(out, { recursive: true });
    const reportPath = resolve(out, `proposal-report-${stamp}.json`);
    await writeFile(reportPath, JSON.stringify(proposal, null, 2));
    let batchPath = null;
    if (result.batch) { batchPath = resolve(out, `safe-batch-${stamp}.json`); await writeFile(batchPath, JSON.stringify(result.batch, null, 2)); }
    console.log(JSON.stringify({ status: proposal.status, block: stamp, safe: `${proposal.safe.address} (Safe ${proposal.safe.version}, ${proposal.safe.threshold}/${proposal.safe.owners.length})`,
      shares: proposal.sizing.shares, previewAssets: proposal.previews.assets, simulation: proposal.simulation.status, checks: proposal.simulation.checks, failedAt: proposal.simulation.failedAt ?? proposal.simulation.stage,
      files: { report: reportPath, batch: batchPath } }, null, 2));
    if (!result.batch) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ error: error.message?.startsWith('Usage:') ? error.message : publicError(error), secretsPrinted: false }));
    process.exitCode = 1;
  }
}
