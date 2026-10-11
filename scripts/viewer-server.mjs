import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadFixture, evaluateFixture, defaultScenario } from './fixture-demo.mjs';
import { inspectVault } from '../dist/live/inspect.js';
import { analyzeLive } from '../dist/live/analyze.js';
import { quoteRedemption } from '../dist/live/exit.js';
import { loadReplay } from '../dist/live/replay.js';
import { findPublicHolder } from '../dist/live/holders.js';
import { assessDependencies } from '../dist/live/assess.js';
import { api, liveOptions } from './live-config.mjs';
import { createAutomationService, assessWithForecast } from './automation-service.mjs';
import { simulateMigration } from './fork-migration.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const targets = {
  MARKET_LOSS: 'lending_market', ORACLE_STALE: 'oracle', CHAIN_OUTAGE: 'chain',
  ASSET_DEPEG: 'asset', CONTRACT_EXPLOIT: 'vault', LIQUIDITY_SHOCK: 'amm'
};
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function readBody(request, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function parseScenario(body, snapshot) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a scenario object');
  const node = snapshot.nodes.find(n => n.id === body.targetNodeId);
  if (!Object.hasOwn(targets, body.kind) || !node || node.kind !== targets[body.kind]) {
    throw new Error('Select a fixture node matching the scenario category');
  }
  const bounded = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  if (!bounded(body.horizonHours, 1, 8760)) throw new Error('Horizon must be between 1 and 8760 hours');
  if (body.kind === 'MARKET_LOSS' && !bounded(body.severityFraction, 0, 1)) throw new Error('Market loss must be between 0% and 100%');
  if (body.probabilityWithinHorizon != null && !bounded(body.probabilityWithinHorizon, 0, 1)) throw new Error('Probability must be between 0% and 100%');
  if (body.exitCostUsd != null && !bounded(body.exitCostUsd, 0, 1e12)) throw new Error('Exit cost must be a finite nonnegative amount');
  return {
    scenario: {
      id: 'interactive-fixture-scenario', kind: body.kind, targetNodeId: node.id,
      horizonHours: body.horizonHours,
      ...(body.kind === 'MARKET_LOSS' ? { severityFraction: body.severityFraction } : {}),
      ...(body.probabilityWithinHorizon != null ? { probabilityWithinHorizon: body.probabilityWithinHorizon } : {})
    },
    exitCostUsd: body.exitCostUsd ?? null
  };
}

export function createViewerServer() {
  const snapshot = loadFixture();
  const jobs = new Map();
  const snapshots = new Map();
  const quotes = new Map();
  const automation = createAutomationService();
  let forkActive = false;
  let active = 0;
  const requestSchema = z.object({
    snapshotId: z.string().max(400), kind: z.enum(['MARKET_LOSS', 'ORACLE_STALE', 'CHAIN_OUTAGE', 'ASSET_DEPEG', 'CONTRACT_EXPLOIT', 'LIQUIDITY_SHOCK']),
    targetNodeId: z.string().max(400), horizonHours: z.number().finite().min(1).max(8760), severityFraction: z.number().finite().min(0).max(1).optional(),
    probabilityWithinHorizon: z.number().finite().min(0).max(1).nullish(), positionUsd: z.number().finite().min(0).max(1e12).nullish(),
    exitCostUsd: z.number().finite().min(0).max(1e12).nullish(), quoteId: z.string().uuid().optional()
  });
  const getSnapshot = id => {
    const item = snapshots.get(id);
    if (!item) throw new Error('SNAPSHOT_NOT_FOUND');
    return item;
  };
  const initialReport = live => {
    const market = live.nodes.find(node => node.kind === 'lending_market');
    return analyzeLive(live, { id: 'hypothetical-live-stress', kind: market ? 'MARKET_LOSS' : 'CONTRACT_EXPLOIT', targetNodeId: market?.id ?? live.rootPositionId, severityFraction: .2, horizonHours: 24 }, { positionUsd: null });
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const port = response.socket.localPort;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host)) return json(response, 403, { error: 'Use the local server address' });
      if (request.method === 'POST' && request.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin)) return json(response, 403, { error: 'Cross-origin requests are not allowed' });
      if (request.method === 'GET' && path === '/api/status') return json(response, 200, { appVersion: 'automatic-flow-v2', rpcConfigured: Boolean(process.env.ETHEREUM_RPC_URL), etherscanConfigured: Boolean(process.env.ETHERSCAN_API_KEY), mode: 'read_only' });
      if (request.method === 'GET' && path === '/api/backtest') {
        try { return json(response, 200, JSON.parse(await readFile(new URL('../datasets/backtest-report.json', import.meta.url), 'utf8'))); }
        catch { return json(response, 503, { error: 'Historical benchmark unavailable. Run npm run data:history then npm run backtest.' }); }
      }
      if (request.method === 'GET' && path === '/api/automation') return json(response, 200, { monitors: automation.listMonitors() });
      if (request.method === 'POST' && path === '/api/automation') {
        try { return json(response, 202, automation.start(await readBody(request))); }
        catch { return json(response, 400, { error: 'Use one Ethereum source, positive USD size and up to three destination vaults. One monitor and one automation cycle may run at a time.' }); }
      }
      if (request.method === 'GET' && path.startsWith('/api/automation/')) {
        const run = automation.get(path.slice('/api/automation/'.length));
        if (run?.result) for (const snapshot of [run.result.source, ...run.result.destinations]) {
          if (!snapshots.has(snapshot.snapshotId) && snapshots.size >= 30) { const oldest = snapshots.keys().next().value; snapshots.delete(oldest); quotes.delete(oldest); }
          snapshots.set(snapshot.snapshotId, snapshot);
        }
        return json(response, run ? 200 : 404, run ? { ...run, report: run.source ? initialReport(run.source) : null } : { error: 'Automation run not found' });
      }
      if (request.method === 'POST' && path === '/api/automation/stop') {
        try { const { id } = z.object({ id: z.string().uuid() }).parse(await readBody(request)); return json(response, automation.stop(id) ? 200 : 404, { stopped: true }); }
        catch { return json(response, 400, { error: 'Supply an automation run ID.' }); }
      }
      if (request.method === 'POST' && path === '/api/fork-migration') {
        if (forkActive) return json(response, 429, { error: 'A local fork simulation is already running.' });
        let body, source, destination;
        try {
          body = z.object({ sourceSnapshotId: z.string().max(400), destinationSnapshotId: z.string().max(400), owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/), positionUsd: z.number().finite().positive().max(1e12), moveFraction: z.number().finite().positive().max(1).default(1) }).parse(await readBody(request));
          source = getSnapshot(body.sourceSnapshotId); destination = getSnapshot(body.destinationSnapshotId);
          if ([source, destination].some(s => s.chainId !== 1 || s.mode !== 'live' || Date.now() - Date.parse(s.observedAt) > 300_000)) throw new Error('STALE');
        } catch { return json(response, 400, { error: 'Supply two fresh Ethereum vault snapshots, a public EOA owner and a migration fraction.' }); }
        forkActive = true;
        const id = randomUUID(); jobs.set(id, { status: 'running' });
        simulateMigration({ source: source.nodes.find(n => n.id === source.rootPositionId).address, destination: destination.nodes.find(n => n.id === destination.rootPositionId).address, owner: body.owner, positionUsd: body.positionUsd, moveFraction: body.moveFraction })
          .then(result => jobs.set(id, { status: 'complete', fork: result }))
          .catch(error => jobs.set(id, { status: 'failed', error: error.message }))
          .finally(() => { forkActive = false; });
        return json(response, 202, { jobId: id, mode: 'LOCAL_FORK_ONLY' });
      }
      if (request.method === 'POST' && path === '/api/assess') {
        try {
          const body = z.object({ snapshotId: z.string().max(400), positionUsd: z.number().finite().positive().max(1e12).nullable() }).parse(await readBody(request));
          return json(response, 200, await assessWithForecast(getSnapshot(body.snapshotId), body.positionUsd));
        } catch { return json(response, 400, { error: 'Supply a loaded provider snapshot and a positive USD position value (or null).' }); }
      }
      if (request.method === 'POST' && path === '/api/replay') {
        try {
          const recording = loadReplay(await readBody(request, 2_000_000));
          if (snapshots.size >= 30) { const oldest = snapshots.keys().next().value; snapshots.delete(oldest); quotes.delete(oldest); }
          snapshots.set(recording.snapshotId, recording);
          return json(response, 200, initialReport(recording));
        } catch { return json(response, 400, { error: 'Invalid or oversized snapshot recording. Use a live graph JSON exported by this application.' }); }
      }
      if (request.method === 'GET' && path === '/api/catalogue') {
        const parameters = new URL(request.url, 'http://localhost').searchParams;
        const chainId = Number(parameters.get('chainId') ?? 1);
        const version = Number(parameters.get('version') ?? 1);
        const cursor = parameters.get('cursor') ?? undefined;
        if (!Number.isSafeInteger(chainId) || chainId < 1 || ![1, 2].includes(version) || (cursor?.length ?? 0) > 2000) return json(response, 400, { error: 'Invalid catalogue query' });
        try { return json(response, 200, await api.list(chainId, version, cursor)); }
        catch { return json(response, 503, { error: 'Catalogue unavailable or rate-limited. You can still enter a vault address.' }); }
      }
      if (request.method === 'POST' && path === '/api/inspect') {
        let body;
        try { body = z.object({ selector: z.string().max(100), enrichment: z.boolean().optional() }).parse(await readBody(request)); liveOptions(body.selector); }
        catch { return json(response, 400, { error: 'Use <chainId>:<0x-vault-address>' }); }
        if (active >= 2) return json(response, 429, { error: 'Two inspections are already running. Wait for one to finish.' });
        while (jobs.size >= 30) { const id = [...jobs.keys()].find(id => jobs.get(id).status !== 'running'); if (!id) break; jobs.delete(id); }
        const id = randomUUID();
        jobs.set(id, { status: 'running' });
        active++;
        inspectVault(body.selector, liveOptions(body.selector, body.enrichment !== false)).then(live => {
          if (snapshots.size >= 30) { const oldest = snapshots.keys().next().value; snapshots.delete(oldest); quotes.delete(oldest); }
          snapshots.set(live.snapshotId, live);
          jobs.set(id, { status: 'complete', report: initialReport(live) });
        }).catch(error => {
          const safe = typeof error?.message === 'string' && /^(NOT_INDEXED|UNSUPPORTED_CONTRACT|ADDRESS_HAS_NO_CONTRACT_CODE|RPC_CHAIN_MISMATCH|INVALID_SELECTOR|UPSTREAM_SCHEMA_MISMATCH)/.test(error.message);
          jobs.set(id, { status: 'failed', error: safe ? error.message : 'Inspection unavailable. Check provider status or retry later; no fixture fallback was substituted.' });
        }).finally(() => { active--; });
        return json(response, 202, { jobId: id });
      }
      if (request.method === 'GET' && path.startsWith('/api/jobs/')) {
        const job = jobs.get(path.slice('/api/jobs/'.length));
        return json(response, job ? 200 : 404, job ?? { error: 'Job not found' });
      }
      if (request.method === 'POST' && path === '/api/quote-exit') {
        let body, live;
        try { body = z.object({ snapshotId: z.string().max(400), owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/), shares: z.string().regex(/^\d+$/).max(78).optional() }).parse(await readBody(request)); live = getSnapshot(body.snapshotId); }
        catch { return json(response, 400, { error: 'Supply a current snapshot and public owner address; shares are optional raw units.' }); }
        if (live.mode !== 'live') return json(response, 400, { error: 'Current exit quotes require a fresh live inspection.' });
        const options = liveOptions(`${live.chainId}:${live.nodes.find(node => node.id === live.rootPositionId).address}`);
        if (!options.rpc) return json(response, 503, { error: 'Configure the RPC endpoint for this chain to assess redemption.' });
        const quote = await quoteRedemption(live, options.rpc, api, body.owner, body.shares);
        const quoteId = randomUUID();
        quotes.set(live.snapshotId, { quoteId, quote });
        return json(response, 200, { ...quote, quoteId });
      }
      if (request.method === 'POST' && path === '/api/public-holder') {
        try {
          const body = z.object({ snapshotId: z.string().max(400), positionUsd: z.number().finite().positive().max(1e12).optional() }).parse(await readBody(request));
          const live = getSnapshot(body.snapshotId);
          const root = live.nodes.find(n => n.id === live.rootPositionId);
          const options = liveOptions(`${live.chainId}:${root.address}`);
          if (!options.rpc) return json(response, 503, { error: 'An RPC endpoint is required to verify public holder balances.' });
          return json(response, 200, await findPublicHolder(live, options.rpc, api, body.positionUsd));
        } catch { return json(response, 503, { error: 'No public holder with enough verified shares was found in the bounded search, or a fresh sizing price is unavailable. Try a smaller demo position or a known holder of this vault.' }); }
      }
      if (request.method === 'GET' && path === '/api/demo') {
        return json(response, 200, evaluateFixture(snapshot, defaultScenario));
      }
      if (request.method === 'POST' && path === '/api/simulate') {
        if (request.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin)) {
          return json(response, 403, { error: 'Cross-origin scenario requests are not allowed' });
        }
        if (!request.headers['content-type']?.startsWith('application/json')) {
          return json(response, 415, { error: 'Use application/json' });
        }
        let parsed;
        try {
          const body = await readBody(request);
          if (body.snapshotId && body.snapshotId !== snapshot.snapshotId) {
            const input = requestSchema.parse(body);
            const live = getSnapshot(input.snapshotId);
            const node = live.nodes.find(node => node.id === input.targetNodeId);
            if (!node || input.kind !== 'CONTRACT_EXPLOIT' && node.kind !== targets[input.kind]) throw new Error('Scenario category does not match the selected dependency');
            const saved = quotes.get(live.snapshotId);
            const quote = input.quoteId && saved?.quoteId === input.quoteId ? saved.quote : undefined;
            const scenario = { id: 'hypothetical-live-stress', kind: input.kind, targetNodeId: input.targetNodeId, horizonHours: input.horizonHours, severityFraction: input.severityFraction, ...(input.probabilityWithinHorizon != null ? { probabilityWithinHorizon: input.probabilityWithinHorizon } : {}) };
            const quoteAge = quote?.quotedAt ? Date.now() - Date.parse(quote.quotedAt) : NaN;
            const freshValuation = Number.isFinite(quoteAge) && quoteAge >= 0 && quoteAge < 60_000;
            const context = { positionUsd: freshValuation && quote?.fullExit && quote.positionValueUsd != null ? quote.positionValueUsd : input.positionUsd ?? null, exit: quote, assumedExitCostUsd: input.exitCostUsd };
            return json(response, 200, analyzeLive(live, scenario, context));
          }
          parsed = parseScenario(body, snapshot);
        }
        catch (error) { return json(response, error.message === 'Request too large' ? 413 : 400, { error: error.message }); }
        return json(response, 200, evaluateFixture(snapshot, parsed.scenario, parsed.exitCostUsd));
      }
      const file = files.get(path);
      if (request.method === 'GET' && file) {
        const contents = await readFile(new URL(`../viewer/${file[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': file[1] });
        return response.end(contents);
      }
      json(response, 404, { error: 'Not found' });
    } catch {
      json(response, 500, { error: 'Unable to serve the request; provider or validation failed' });
    }
  });
  server.once('close', () => automation.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const server = createViewerServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied. Try PORT=3001 npm run dev.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`DeFi Risk Radar: http://localhost:${port}`);
    console.log('Read-only live discovery — keys stay on the server. Press Ctrl+C to stop.');
  });
}
