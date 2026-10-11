import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createAutomationService } from '../scripts/automation-service.mjs';
import { assessDependencies } from '../dist/live/assess.js';
const address = n => `0x${String(n).padStart(40, '0')}`;
const source = `1:${address(1)}`, destination = `1:${address(2)}`;
function graph(selector) {
  const observedAt = new Date().toISOString(), root = `eip155:${selector}`, market = `${root}:market`, collateral = `${root}:collateral`;
  const evidence = { status: 'verified', sourceType: 'onchain_call', blockNumber: '100', observedAt };
  return { schemaVersion: '1.0', snapshotId: root, mode: 'live', observedAt, chainId: 1, blockNumber: '100', blockTimestamp: observedAt, rootPositionId: root,
    nodes: [{ id: root, kind: 'vault', label: selector, address: selector.slice(2) }, { id: market, kind: 'lending_market' }],
    edges: [{ from: root, to: market, kind: 'ALLOCATES_TO', evidence }, { from: root, to: 'USDC', kind: 'ACCOUNTING_ASSET', evidence }, { from: market, to: collateral, kind: 'ACCEPTS_COLLATERAL', evidence }],
    exposures: [{ marketId: market, vaultId: root, fraction: 1, path: [root, market], evidence }], observations: [], unknowns: [] };
}
async function finished(service, id) {
  for (let i = 0; i < 100; i++) { const run = service.get(id); if (run.status !== 'running') return run; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('TEST_TIMEOUT');
}
test('automation deduplicates destinations, proposes a partial move and confines rehearsal to opted-in fork mode', async () => {
  const directory = await mkdtemp('/tmp/radar-automation-test-');
  let simulations = 0; const inspected = [];
  const service = createAutomationService({ stateDir: pathToFileURL(directory + '/'), inspect: async selector => { inspected.push(selector); return graph(selector); },
    assess: async (snapshot, size) => ({ ...assessDependencies(snapshot, size), forecasts: [{ role: 'ACCOUNTING_ASSET', status: 'EXPERIMENTAL_REFERENCE', regime: 'PEGGED' }] }),
    simulate: async () => { simulations++; return { status: 'FORK_SIMULATION_PASSED', mainnetTransactionsSent: 0 }; } });
  const policy = { maxMarketFraction: .6, maxCollateralFraction: .6, maxMoveFraction: 1 };
  try {
    const job = service.start({ selector: source, positionUsd: 10000, destinations: [source, destination, destination], policy });
    const run = await finished(service, job.id);
    assert.equal(run.status, 'complete');
    assert.deepEqual(inspected, [source, destination]);
    assert.equal(run.result.allocation.selected.moveFraction, .4);
    assert.equal(simulations, 0);
    const enabled = service.start({ selector: source, positionUsd: 10000, destinations: [destination], policy, forkDemoOwner: address(3) });
    assert.throws(() => service.start({ selector: source, positionUsd: 10000, destinations: [destination] }), /AUTOMATION_BUSY/);
    const second = await finished(service, enabled.id);
    assert.equal(second.result.fork.status, 'FORK_SIMULATION_PASSED');
    assert.equal(simulations, 1);
    assert.equal(second.result.liveExecutionEnabled, false);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('observed underlying depeg blocks same-asset automatic fork rehearsal', async () => {
  const directory = await mkdtemp('/tmp/radar-automation-test-');
  let simulated = false;
  const service = createAutomationService({ stateDir: pathToFileURL(directory + '/'), inspect: async selector => graph(selector),
    assess: async (snapshot, size) => ({ ...assessDependencies(snapshot, size), forecasts: [{ role: 'ACCOUNTING_ASSET', regime: 'DEPEG' }] }),
    simulate: async () => { simulated = true; } });
  try {
    const run = await finished(service, service.start({ selector: source, positionUsd: 10000, destinations: [destination], policy: { maxMarketFraction: .6, maxCollateralFraction: .6, maxMoveFraction: 1 }, forkDemoOwner: address(3) }).id);
    assert.equal(run.result.forkRehearsalStatus, 'SAME_ASSET_CANNOT_HEDGE_DEPEG');
    assert.equal(simulated, false);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('stopping an in-flight monitor prevents subsequent rehearsal and scheduling', async () => {
  const directory = await mkdtemp('/tmp/radar-automation-test-');
  let release; const pending = new Promise(r => { release = r; }); let simulated = false;
  const service = createAutomationService({ stateDir: pathToFileURL(directory + '/'), inspect: async selector => { await pending; return graph(selector); },
    assess: async (snapshot, size) => ({ ...assessDependencies(snapshot, size), forecasts: [{ role: 'ACCOUNTING_ASSET', status: 'EXPERIMENTAL_REFERENCE', regime: 'PEGGED' }] }), simulate: async () => { simulated = true; } });
  try {
    const job = service.start({ selector: source, positionUsd: 10000, destinations: [destination], monitor: true, forkDemoOwner: address(3), policy: { maxMarketFraction: .6, maxCollateralFraction: .6, maxMoveFraction: 1 } });
    service.stop(job.id); release();
    for (let i = 0; i < 100 && !service.get(job.id).result; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(simulated, false); assert.equal(service.get(job.id).status, 'stopped'); assert.equal(service.get(job.id).nextAt, null);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('missing dependency price checks cannot enable an automatic rehearsal', async () => {
  const directory = await mkdtemp('/tmp/radar-automation-test-');
  const service = createAutomationService({ stateDir: pathToFileURL(directory + '/'), inspect: async selector => graph(selector),
    assess: async (snapshot, size) => ({ ...assessDependencies(snapshot, size), forecasts: [{ role: 'ACCOUNTING_ASSET', status: 'PRICE_PROVIDER_UNAVAILABLE' }] }),
    simulate: async () => { throw new Error('SHOULD_NOT_RUN'); } });
  try {
    const run = await finished(service, service.start({ selector: source, positionUsd: 10000, destinations: [destination], policy: { maxMarketFraction: .6, maxCollateralFraction: .6, maxMoveFraction: 1 }, forkDemoOwner: address(3) }).id);
    assert.equal(run.result.forkRehearsalStatus, 'DEPENDENCY_PRICE_CHECK_UNAVAILABLE'); assert.equal(run.result.fork, null);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});
