import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inspectVault } from '../dist/live/inspect.js';
import { forecastDependencies } from '../dist/live/forecast.js';
import { PriceClient } from '../dist/connectors/prices.js';
import { planReallocation, defaultAllocationPolicy } from '../dist/automation/allocation.js';
import { api, liveOptions } from './live-config.mjs';
import { simulateMigration } from './fork-migration.mjs';
import { findPublicHolder } from '../dist/live/holders.js';

const policySchema = z.object({ maxMarketFraction: z.number().positive().max(1), maxCollateralFraction: z.number().positive().max(1), maxMoveFraction: z.number().positive().max(1) });
export const automationSchema = z.object({
  selector: z.string().regex(/^1:0x[0-9a-fA-F]{40}$/), positionUsd: z.number().finite().positive().max(1e12),
  destinations: z.array(z.string().regex(/^1:0x[0-9a-fA-F]{40}$/)).max(3),
  policy: policySchema.optional(), monitor: z.boolean().default(false), intervalSeconds: z.number().int().min(300).max(86400).default(300),
  forkDemoOwner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(), autoFork: z.boolean().default(false), enrichment: z.boolean().default(false)
});
const prices = new PriceClient();
let modelPromise;
export async function loadModel() {
  modelPromise ??= readFile(new URL('../models/depeg-v1.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => null);
  return modelPromise;
}
export async function assessWithForecast(snapshot, size) {
  return forecastDependencies(snapshot, size, await loadModel(), prices);
}
export function createAutomationService({ inspect = inspectVault, assess = assessWithForecast, simulate = simulateMigration,
  findHolder = async (source, size) => { const options = liveOptions(`1:${source.nodes.find(n => n.id === source.rootPositionId).address}`, false); if (!options.rpc) throw new Error('RPC_NOT_CONFIGURED'); return findPublicHolder(source, options.rpc, api, size); },
  stateDir = new URL('../.radar/', import.meta.url) } = {}) {
  const runs = new Map();
  let active = false;
  let closing = false;
  const journal = async (event) => {
    await mkdir(stateDir, { recursive: true });
    await appendFile(new URL('automation.jsonl', stateDir), JSON.stringify(event) + '\n');
  };
  const tick = async run => {
    if (closing || run.stopped) return;
    if (active) { run.nextAt = new Date(Date.now() + 5000).toISOString(); run.timer = setTimeout(() => tick(run), 5000); return; }
    active = true; run.inFlight = true; run.status = 'running'; run.nextAt = null; run.error = null; run.stage = 'Inspecting selected source vault';
    try {
      const config = run.config;
      const source = await inspect(config.selector, liveOptions(config.selector, config.enrichment));
      run.source = source;
      const selectors = [...new Set(config.destinations.map(d => d.toLowerCase()))].filter(d => d !== config.selector.toLowerCase());
      const destinations = [], failures = [];
      // Bounded and sequential per vault, while the RPC layer handles four concurrent reads.
      for (const selector of selectors) {
        run.stage = `Inspecting destination ${destinations.length + failures.length + 1} of ${selectors.length}`;
        try { destinations.push(await inspect(selector, liveOptions(selector, false))); }
        catch { failures.push({ selector, status: 'INSPECTION_UNAVAILABLE' }); }
      }
      run.stage = 'Checking live prices and calculating exposures';
      const assessment = await assess(source, config.positionUsd);
      const allocation = planReallocation(source, destinations, config.positionUsd, config.policy ?? defaultAllocationPolicy);
      const structure = new Set(source.edges.filter(e => e.evidence.status === 'verified').map(e => `${e.from}|${e.kind}|${e.to}`));
      const changes = run.previous ? { added: [...structure].filter(e => !run.previous.has(e)), removed: [...run.previous].filter(e => !structure.has(e)) } : { added: [], removed: [] };
      run.previous = structure;
      const depegObserved = assessment.forecasts.some(f => f.role === 'ACCOUNTING_ASSET' && ['WATCH', 'DEPEG', 'DISTRESSED'].includes(f.regime));
      const rootPriceChecked = assessment.forecasts.some(f => f.role === 'ACCOUNTING_ASSET' && f.status === 'EXPERIMENTAL_REFERENCE');
      let fork = null;
      const rehearsalEnabled = config.autoFork || Boolean(config.forkDemoOwner);
      if (rehearsalEnabled && allocation.selected && rootPriceChecked && !depegObserved && !assessment.failedRoundChecks && !run.stopped && !closing && !run.forkAttempted) {
        run.forkAttempted = true; // One bounded rehearsal per setup, even if it fails. No retry writes.
        const destination = destinations.find(d => d.rootPositionId === allocation.selected.destinationId);
        try {
          run.stage = 'Finding a public holder with enough shares for this position';
          const owner = config.forkDemoOwner ?? (await findHolder(source, config.positionUsd)).owner;
          if (run.stopped || closing) throw new Error('MONITOR_STOPPED');
          run.stage = 'Executing bounded atomic migration on an isolated local fork';
          fork = await simulate({ source: source.nodes.find(n => n.id === source.rootPositionId).address,
            destination: destination.nodes.find(n => n.id === destination.rootPositionId).address,
            owner, positionUsd: config.positionUsd, moveFraction: allocation.selected.moveFraction });
        } catch (error) { fork = { status: 'FORK_SIMULATION_FAILED', error: error.message, mainnetTransactionsSent: 0 }; }
      }
      run.result = { schemaVersion: '1.0', mode: 'AUTOMATED_READ_ONLY_MONITOR', cycle: ++run.cycles, completedAt: new Date().toISOString(),
        source, destinations, destinationFailures: failures, assessment, allocation, structuralChanges: changes, fork,
        forkRehearsalStatus: !rehearsalEnabled ? 'NOT_ENABLED' : fork ? fork.status : run.forkAttempted ? 'ONE_ATTEMPT_LIMIT_REACHED' : depegObserved ? 'SAME_ASSET_CANNOT_HEDGE_DEPEG' : !rootPriceChecked ? 'DEPENDENCY_PRICE_CHECK_UNAVAILABLE' : 'NO_ELIGIBLE_POLICY_MOVE',
        alerts: [...(depegObserved ? [{ type: 'OBSERVED_UNDERLYING_DEPEG', explanation: 'Switching vaults holding the same token retains this risk. A different-asset swap and executable liquidity model are required.' }] : []),
          ...(assessment.failedRoundChecks ? [{ type: 'ORACLE_ROUND_CHECK_FAILED', explanation: 'Pricing read needs investigation; this is not a measured lender loss.' }] : []),
          ...(changes.added.length || changes.removed.length ? [{ type: 'DEPENDENCIES_CHANGED', explanation: 'Verified configuration relationships changed since the previous cycle.' }] : [])],
        liveExecutionEnabled: false, forecastExecutionValidated: false };
      await mkdir(stateDir, { recursive: true });
      await writeFile(new URL(`${run.id}.json`, stateDir), JSON.stringify(run.result, null, 2) + '\n');
      await journal({ at: run.result.completedAt, runId: run.id, cycle: run.cycles, sourceSnapshotId: source.snapshotId,
        block: source.blockNumber, allocationStatus: allocation.status, destinationId: allocation.selected?.destinationId ?? null,
        moveFraction: allocation.selected?.moveFraction ?? null, alerts: run.result.alerts, forkStatus: run.result.forkRehearsalStatus, liveExecutionEnabled: false });
      run.status = run.stopped ? 'stopped' : 'complete';
      run.stage = run.stopped ? 'Stopped' : 'Cycle complete';
    } catch { run.status = run.stopped ? 'stopped' : 'failed'; run.error = 'Live automation cycle unavailable. Missing data are not replaced by fixture values.'; }
    finally {
      active = false;
      run.inFlight = false;
      if (run.config.monitor && !run.stopped && !closing) {
        run.nextAt = new Date(Date.now() + run.config.intervalSeconds * 1000).toISOString();
        run.timer = setTimeout(() => tick(run), run.config.intervalSeconds * 1000);
      }
    }
  };
  return {
    start(input) {
      const config = automationSchema.parse(input);
      if (config.monitor && [...runs.values()].filter(r => r.config.monitor && !r.stopped).length >= 1) throw new Error('MONITOR_ALREADY_RUNNING');
      if (active) throw new Error('AUTOMATION_BUSY');
      while (runs.size >= 20) {
        const old = [...runs.values()].find(r => !r.config.monitor || r.stopped); if (!old) throw new Error('AUTOMATION_BUSY'); runs.delete(old.id);
      }
      const run = { id: randomUUID(), config, status: 'running', stopped: false, cycles: 0, result: null, nextAt: null };
      runs.set(run.id, run); void tick(run); return { id: run.id, status: run.status, monitor: config.monitor };
    },
    get(id) {
      const run = runs.get(id);
      if (!run) return null;
      return { id, status: run.status, inFlight: Boolean(run.inFlight), stage: run.stage, selector: run.config.selector, positionUsd: run.config.positionUsd, source: run.source ?? null, monitor: run.config.monitor, stopped: run.stopped, cycles: run.cycles, nextAt: run.nextAt, result: run.result, error: run.error ?? null };
    },
    listMonitors() { return [...runs.values()].filter(run => run.config.monitor && !run.stopped).map(run => ({ id: run.id, selector: run.config.selector, positionUsd: run.config.positionUsd, destinations: run.config.destinations, policy: run.config.policy ?? defaultAllocationPolicy, autoFork: run.config.autoFork || Boolean(run.config.forkDemoOwner) })); },
    stop(id) { const run = runs.get(id); if (!run) return false; run.stopped = true; clearTimeout(run.timer); run.status = 'stopped'; run.nextAt = null; return true; },
    close() { closing = true; for (const run of runs.values()) { clearTimeout(run.timer); run.stopped = true; } }
  };
}
