const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const money = value => value == null ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const targetKinds = { MARKET_LOSS: 'lending_market', ORACLE_STALE: 'oracle', CHAIN_OUTAGE: 'chain', ASSET_DEPEG: 'asset', CONTRACT_EXPLOIT: 'vault', LIQUIDITY_SHOCK: 'amm' };
let report;
let selected;
let activeQuoteId;
let assessmentSequence = 0;
let automationRun;
let monitorId;
let automationTimer;
let watchedAutomationId;
let renderedCycle;
let zoom = .85;
let scene = { width: 1200, height: 660 };

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function renderForecasts(container, forecasts) {
  container.append(element('h3', 'Automatic stablecoin price assessment'));
  if (!forecasts.length) container.append(element('p', 'No supported USD stablecoin price model matches these verified dependencies. Unmodelled risk remains unknown.'));
  for (const forecast of forecasts) {
    const card = element('div', undefined, 'requirements-card');
    card.append(element('strong', `${forecast.symbol} · ${forecast.role.replaceAll('_', ' ')}`));
    card.append(element('p', `${forecast.status.replaceAll('_', ' ')}${forecast.priceUsd == null ? '' : ` · observed price $${forecast.priceUsd.toFixed(5)} · ${forecast.marketAsOf}`}`));
    if (forecast.probabilityWithinHorizon != null) {
      card.append(element('p', `Historical-reference probability of a further 2% drop within 24 hours: ${(100 * forecast.probabilityWithinHorizon).toFixed(2)}%. Training ends ${forecast.trainedThrough.slice(0, 10)}; this is not calibrated for current live execution.`));
      card.append(element('p', `Support: ${forecast.reference.samples} overlapping hourly labels across ${forecast.reference.productDayClusters} product-day groups. ${forecast.reference.support.replaceAll('_', ' ')}. ${forecast.reference.caveat}`));
      if (forecast.expectedUsdMarkDownside != null) card.append(element('p', `Experimental expected 24-hour USD mark downside: ${money(forecast.expectedUsdMarkDownside)}. This holds underlying units constant and excludes bad debt, yield and recovery beyond 24 hours.`));
    }
    card.append(element('p', forecast.lossMechanism));
    if (forecast.source) {
      const link = element('a', 'Price-data source'); link.href = forecast.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
    }
    container.append(card);
  }
}

const selectedSelector = () => `${$('chain-id').value}:${$('vault-address').value.trim().toLowerCase()}`;
async function stopOwnedMonitor() {
  if (!monitorId) return;
  const id = monitorId;
  const response = await fetch('/api/automation/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!response.ok) throw new Error('Could not stop the previous monitor.');
  monitorId = null; watchedAutomationId = null; clearTimeout(automationTimer); $('stop-monitor').disabled = true;
  for (let i = 0; i < 120; i++) {
    const status = await (await fetch(`/api/automation/${id}`)).json();
    if (!status.inFlight) return;
    $('pipeline-status').textContent = 'The previous monitor is stopping; waiting for its current read to finish…';
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Previous data reads are still finishing. Retry shortly.');
}
async function startAutomation(monitor, primary = false) {
  const size = Number($('assessment-usd').value);
  const selector = selectedSelector();
  if (!/^1:0x[0-9a-f]{40}$/.test(selector) || !Number.isFinite(size) || size <= 0) { $('pipeline-status').textContent = 'Enter a valid Ethereum vault address and a positive position value.'; return; }
  const destinations = $('destination-addresses').value.split(/\s+/).filter(Boolean).map(address => `1:${address}`);
  const policy = { maxMarketFraction: Number($('limit-market').value) / 100, maxCollateralFraction: Number($('limit-collateral').value) / 100, maxMoveFraction: Number($('limit-move').value) / 100 };
  $('compare-destinations').disabled = true; $('start-monitor').disabled = true;
  $('run-automatic').disabled = true;
  $('automation-result').textContent = 'Refreshing source accounting, candidate vaults and live prices. This can take a few minutes…';
  try {
    await stopOwnedMonitor();
    ++activeInspection; ++assessmentSequence; $('inspect').disabled = false;
    const response = await fetch('/api/automation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selector, positionUsd: size, destinations, policy, monitor, autoFork: $('auto-fork').checked, enrichment: primary }) });
    const job = await response.json(); if (!response.ok) throw new Error(job.error);
    if (monitor) { monitorId = job.id; $('stop-monitor').disabled = false; }
    watchedAutomationId = job.id; renderedCycle = undefined;
    $('pipeline-status').textContent = `Starting ${selector} · ${money(size)} · ${monitor ? 'monitoring enabled' : 'one comparison'}.`;
    clearTimeout(automationTimer);
    pollAutomation(job.id);
  } catch (error) {
    $('automation-result').textContent = error.message;
    $('pipeline-status').textContent = error.message;
    $('run-automatic').disabled = false;
    $('compare-destinations').disabled = false; $('start-monitor').disabled = Boolean(monitorId);
  }
}
async function pollAutomation(id) {
  try {
    const response = await fetch(`/api/automation/${id}`); const run = await response.json();
    if (id !== watchedAutomationId) return;
    if (!response.ok) throw new Error(run.error);
    const sameSelection = run.selector.toLowerCase() === selectedSelector() && Number($('assessment-usd').value) === run.positionUsd;
    $('pipeline-status').textContent = `${run.stage ?? run.status} · ${run.selector} · configured amount ${money(run.positionUsd)}${run.nextAt ? ` · next check ${new Date(run.nextAt).toLocaleTimeString()}` : ''}${sameSelection ? '' : ' · Inputs changed: restart automatic analysis to apply them.'}`;
    const newerGraph = run.report && (!report || report.snapshot.rootPositionId !== run.report.snapshot.rootPositionId || Date.parse(run.report.snapshot.observedAt) >= Date.parse(report.snapshot.observedAt));
    if (sameSelection && newerGraph && report?.snapshot.snapshotId !== run.report.snapshot.snapshotId) showReport(run.report, { skipAssessment: true, preserveInputs: true });
    if (run.result) {
      automationRun = sameSelection ? run.result : null; renderAutomation(run);
      if (sameSelection && run.source?.snapshotId === run.result.source.snapshotId && renderedCycle !== `${id}:${run.cycles}`) { renderedCycle = `${id}:${run.cycles}`; renderAssessment(run.result.assessment, run.positionUsd); }
      if (sameSelection && run.result.fork?.owner) { $('fork-owner').value = run.result.fork.owner; $('owner').value = run.result.fork.owner; }
    }
    if (run.status === 'failed') $('automation-result').textContent = `${run.error}${run.nextAt ? ` Retry at ${run.nextAt}.` : ''}`;
    if (run.status === 'running' || run.monitor && !run.stopped) automationTimer = setTimeout(() => pollAutomation(id), run.status === 'running' ? 2000 : 5000);
    else { $('compare-destinations').disabled = false; $('start-monitor').disabled = Boolean(monitorId); }
    if (run.status !== 'running') $('run-automatic').disabled = false;
    if (run.status === 'complete') { $('compare-destinations').disabled = false; $('start-monitor').disabled = Boolean(monitorId); }
  } catch (error) { $('automation-result').textContent = `Automation status unavailable: ${error.message}`; $('compare-destinations').disabled = false; $('run-automatic').disabled = false; }
}
function renderAutomation(run) {
  const data = run.result, plan = data.allocation, container = $('automation-result'); container.replaceChildren();
  const root = data.source.nodes.find(n => n.id === data.source.rootPositionId);
  container.append(element('h3', `${root.label} · ${plan.status.replaceAll('_', ' ')}`));
  container.append(element('p', `Analysed source: ${root.address} · configured position ${money(plan.positionUsd)}.`, 'explanation'));
  container.append(element('p', `Cycle ${data.cycle} · fresh source block ${data.source.blockNumber} · ${data.completedAt}${run.nextAt ? ` · next check ${run.nextAt}` : ''}`));
  container.append(element('p', plan.objective));
  if (plan.baseline) container.append(element('p', `Largest market: ${(plan.baseline.largestMarket * 100).toFixed(2)}%. Largest collateral dependency: ${(plan.baseline.largestCollateral * 100).toFixed(2)}%.`));
  const select = $('fork-destination'); select.replaceChildren(element('option', 'Select a destination'));
  select.firstChild.value = '';
  for (const candidate of plan.candidates) {
    const card = element('div', undefined, 'requirements-card');
    card.append(element('strong', `${candidate.label} · ${candidate.status.replaceAll('_', ' ')}`));
    if (candidate.moveFraction != null) card.append(element('p', `Proposed move: ${(candidate.moveFraction * 100).toFixed(3)}% · ${money(candidate.moveUsd)} of the entered position. After: largest market ${(candidate.after.largestMarket * 100).toFixed(2)}%, collateral ${(candidate.after.largestCollateral * 100).toFixed(2)}%.`));
    if (candidate.retainedDependencies) card.append(element('p', `${candidate.retainedDependencies.length} identified shared dependencies retained, including the underlying asset. Expected loss reduction and full USD migration cost remain unknown.`));
    container.append(card);
    if (candidate.status !== 'INCOMPATIBLE_DESTINATION' && candidate.status !== 'INCOMPLETE_ACCOUNTING' && candidate.status !== 'SNAPSHOT_TIME_MISMATCH') {
      const option = element('option', candidate.label); option.value = candidate.snapshotId; select.append(option);
    }
  }
  if (plan.selected) { select.value = plan.selected.snapshotId; $('fork-fraction').value = String(Math.min(100, plan.selected.moveFraction * 100)); }
  $('run-fork').disabled = select.options.length < 2;
  for (const alert of data.alerts) container.append(element('p', `${alert.type.replaceAll('_', ' ')}: ${alert.explanation}`, 'explanation'));
  for (const fail of data.destinationFailures) container.append(element('p', `${fail.selector}: ${fail.status.replaceAll('_', ' ')}`));
  if (data.forkRehearsalStatus !== 'NOT_ENABLED') container.append(element('p', `Automatic local-fork rehearsal: ${data.forkRehearsalStatus.replaceAll('_', ' ')}${data.fork?.error ? ` · ${data.fork.error}` : ''}. Mainnet transactions: 0.`));
  if (data.fork?.status === 'FORK_SIMULATION_PASSED') {
    renderForkCosts(container, data.fork);
    const download = element('button', 'Download automatic fork migration proof'); download.type = 'button'; download.addEventListener('click', () => downloadJson(data.fork, 'automatic-fork-migration.json')); container.append(download);
  }
  renderForecasts(container, data.assessment.forecasts);
  container.append(element('p', 'No funds moved. This is a concentration-policy proposal; missing cost/yield/loss forecasts prevent a complete economic recommendation. The local-fork demonstration below tests actual contracts and permissions separately.', 'explanation'));
}
$('automation-form').addEventListener('submit', event => { event.preventDefault(); startAutomation(false); });
$('start-monitor').addEventListener('click', () => startAutomation(true));
$('run-automatic').addEventListener('click', () => startAutomation(true, true));
$('stop-monitor').addEventListener('click', async () => {
  if (!monitorId) return;
  try {
    const response = await fetch('/api/automation/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: monitorId }) });
    if (!response.ok) throw new Error('Stop request failed');
    monitorId = null; watchedAutomationId = null; clearTimeout(automationTimer); $('stop-monitor').disabled = true; $('start-monitor').disabled = false; $('compare-destinations').disabled = false; $('run-automatic').disabled = false;
    $('pipeline-status').textContent = 'Monitoring stopped. No further cycles will be scheduled.';
    $('automation-result').append(element('p', 'Monitoring stopped. No further cycles will be scheduled.'));
  } catch (error) { $('automation-result').append(element('p', error.message)); }
});
$('fork-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!automationRun) return;
  $('run-fork').disabled = true; $('fork-result').textContent = 'Starting an isolated local fork, testing permission rejection cases and executing an atomic migration…';
  try {
    const response = await fetch('/api/fork-migration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceSnapshotId: automationRun.source.snapshotId, destinationSnapshotId: $('fork-destination').value, owner: $('fork-owner').value.trim(), positionUsd: automationRun.allocation.positionUsd, moveFraction: Number($('fork-fraction').value) / 100 }) });
    const job = await response.json(); if (!response.ok) throw new Error(job.error);
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const res = await fetch(`/api/jobs/${job.jobId}`); const status = await res.json();
      if (!res.ok || status.status === 'failed') throw new Error(status.error);
      if (status.status === 'complete') {
        const result = status.fork; const container = $('fork-result'); container.replaceChildren();
        container.append(element('h3', 'Atomic local-fork migration passed'));
        container.append(element('p', `Ethereum state at block ${result.sourceBlock}, executed on local chain 31337. Mainnet transactions: ${result.mainnetTransactionsSent}.`));
        container.append(element('p', `Shares redeemed (raw): ${result.sharesRedeemed}. Underlying received: ${result.underlyingAmount} tokens. Destination shares issued (raw): ${result.destinationSharesIssued}. This move is sized from your entered position value and uses the public holder’s real fork-state balance.`));
        const list = element('ul');
        for (const test of result.boundaryTests) list.append(element('li', `${test.name}: passed`));
        container.append(list, element('p', `Policy contract ${result.migrator}. Migration ran in one transaction; outputs and allowances were checked.`));
        renderForkCosts(container, result);
        const download = element('button', 'Download fork receipts and permission report'); download.type = 'button'; download.addEventListener('click', () => downloadJson(result, 'fork-migration.json')); container.append(download);
        break;
      }
      if (i === 119) throw new Error('Fork simulation is taking longer than three minutes.');
    }
  } catch (error) { $('fork-result').textContent = `Fork demonstration unavailable: ${error.message}`; }
  finally { $('run-fork').disabled = false; }
});
function renderForkCosts(container, result) {
  const forced = result.liquidityRoute?.kind === 'MORPHO_V2_PERMISSIONLESS_FORCE_DEALLOCATE_THEN_REDEEM';
  container.append(element('p', forced ? `Route: withdraw available liquidity from ${result.liquidityRoute.legs.length} verified Morpho market(s), redeem source shares, then deposit into the destination in one transaction. Extra source shares burned for the withdrawal fee (raw): ${result.routePenaltyShares}.` : 'Route: redeem source shares and deposit into the destination in one transaction.'));
  container.append(element('p', `Fork costs using fresh USD references: setup gas ${money(result.costs.setupGasUsd)}, execution gas ${money(result.costs.executionGasUsd)}, forced-withdrawal fee ${money(result.costs.forcePenaltyUsd)}. Total including rounding friction ${money(result.costUsd)}. These are measured fork-state costs; future execution and resulting allocations require a fresh simulation.`));
}
function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('load-backtest').addEventListener('click', async () => {
  const container = $('backtest-result'); container.textContent = 'Loading the reproducible benchmark…';
  try {
    const response = await fetch('/api/backtest'); const data = await response.json(); if (!response.ok) throw new Error(data.error);
    container.replaceChildren(element('p', `${data.series.reduce((sum, s) => sum + s.rows, 0).toLocaleString()} actual hourly candles. Training: ${data.model.trainedThrough.slice(0, 10)} cutoff. Probability event: a further 2% decline within 24 hours. Guard: two consecutive sub-$0.995 hourly closes with falling price; execute one hour after the signal.`));
    const chart = svgElement('svg', { viewBox: '0 0 960 290', role: 'img', 'aria-label': 'USDC, DAI and USDT hourly USD close prices during March 2023' }); chart.classList.add('backtest-chart');
    const curves = data.curves.filter(c => c.candles.length), timestamps = curves.flatMap(c => c.candles.map(v => v[0]));
    const start = Math.min(...timestamps), end = Math.max(...timestamps);
    const min = .85, max = 1.04; const x = t => 65 + (t - start) / (end - start) * 870, y = p => 245 - (p - min) / (max - min) * 215;
    for (const price of [.85, .9, .95, 1]) {
      chart.append(svgElement('line', { x1: 65, x2: 935, y1: y(price), y2: y(price), stroke: '#33465b' }), svgElement('text', { x: 4, y: y(price) + 5, fill: '#acc0d5' }, `$${price.toFixed(2)}`));
    }
    const controls = element('div', undefined, 'catalogue-controls');
    for (const [index, curve] of curves.entries()) {
      let previous; const segments = curve.candles.map(([t, price]) => { const segment = `${previous !== undefined && t - previous === 3600 ? 'L' : 'M'}${x(t)},${y(price)}`; previous = t; return segment; }).join(' ');
      const path = svgElement('path', { d: segments, fill: 'none', stroke: ['#f7c462', '#7ce1c1', '#80b5ff'][index], 'stroke-width': 2 }); path.append(svgElement('title', {}, curve.product)); chart.append(path);
      const button = element('button', curve.product); button.type = 'button'; button.setAttribute('aria-pressed', 'true'); button.addEventListener('click', () => { const visible = button.getAttribute('aria-pressed') === 'true'; button.setAttribute('aria-pressed', String(!visible)); path.style.display = visible ? 'none' : ''; }); controls.append(button);
    }
    for (let t = start; t <= end; t += 2 * 86400) chart.append(svgElement('text', { x: x(t), y: 277, fill: '#acc0d5', 'text-anchor': 'middle' }, new Date(t * 1000).toISOString().slice(5, 10)));
    container.append(controls, chart, element('p', 'March 2023 hourly close prices, directly quoted in USD on Coinbase and Binance.US. Click a series to toggle it. This chart is price evidence, not a position-sized executable quote.'));
    const table = element('table'); const head = element('tr');
    for (const text of ['Dataset', 'First signal (UTC)', 'Holding at end', 'After migration', 'Final benefit / harm', 'False alarm episodes']) head.append(element('th', text)); table.append(head);
    for (const c of data.counterfactuals.filter(c => c.costBps === 30)) {
      const row = element('tr'); for (const text of [`${c.product} · ${c.role === 'training_in_sample' ? 'IN-SAMPLE TRAINING' : c.role}`, c.signalAt ?? 'No alarm', money(c.holdingTerminalUsd), money(c.reallocatedTerminalUsd), money(c.terminalBenefitUsd), String(c.falseAlarms ?? 'Unknown')]) row.append(element('td', text)); table.append(row);
    }
    const wrap = element('div', undefined, 'table-scroll'); wrap.append(table); container.append(wrap);
    container.append(element('p', 'Each case starts with $10,000. The table assumes 30 basis points (0.3%) total switching cost and actual USDT destination prices. UST is in-sample; USDC, DAI and USDT are held out. USDC/DAI recover, so selling during their depeg harmed final wealth in these tests. The full report includes 0.1% and 1% cost cases.'));
    const metrics = element('ul');
    for (const score of data.scores.filter(s => s.role !== 'validation' && s.brier != null)) metrics.append(element('li', `${score.product} (${score.role}): Brier ${score.brier.toFixed(5)} versus baseline ${score.baselineBrier.toFixed(5)}. Lower is better. ${score.brier > score.baselineBrier ? 'Model underperformed the baseline.' : 'Model beat this baseline on this sample.'} ${score.samples} overlapping test labels.`));
    container.append(metrics, element('p', 'An isolated Binance.US intrahour USDC print reached $0.33; it is retained and flagged in the report. It is not used to claim $6,700 of avoidable loss. No historical vault withdrawal, order-book fill or signing authority is verified.', 'explanation'));
    const download = element('button', 'Download complete benchmark and sources'); download.type = 'button'; download.addEventListener('click', () => downloadJson(data, 'backtest-report.json')); container.append(download);
  } catch (error) { container.textContent = error.message; }
});
function svgElement(tag, attributes = {}, text) {
  const result = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, String(value));
  if (text !== undefined) result.textContent = text;
  return result;
}
function activate(target, callback) {
  target.addEventListener('click', callback);
  target.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); callback(); }
  });
}
function layout(snapshot) {
  const depth = new Map([[snapshot.rootPositionId, 0]]);
  const queue = [snapshot.rootPositionId];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const edge of snapshot.edges.filter(edge => edge.from === id)) {
      if (!depth.has(edge.to)) { depth.set(edge.to, depth.get(id) + 1); queue.push(edge.to); }
    }
  }
  const columns = new Map();
  for (const node of snapshot.nodes) {
    const level = depth.get(node.id) ?? 0;
    const nodes = columns.get(level) ?? [];
    nodes.push(node);
    columns.set(level, nodes);
  }
  const positions = new Map();
  const lastLevel = Math.max(...columns.keys(), 1);
  scene = { width: Math.max(1200, lastLevel * 330 + 280), height: Math.max(660, Math.max(...[...columns.values()].map(nodes => nodes.length)) * 120 + 120) };
  for (const [level, nodes] of columns) {
    const rank = { position: 0, vault: 1, lending_market: 2, asset: 3, oracle: 4, yield_source: 5, issuer: 6, contract: 7, administrator: 8, chain: 9 };
    nodes.sort((a, b) => (rank[a.kind] ?? 7) - (rank[b.kind] ?? 7));
    nodes.forEach((node, index) => positions.set(node.id, {
      x: 20 + level * 330,
      y: nodes.length === 1 ? 330 : 90 + index * 120
    }));
  }
  return positions;
}
function updateZoom() {
  $('graph').setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
  $('graph').setAttribute('width', scene.width * zoom);
  $('graph').setAttribute('height', scene.height * zoom);
}
function drawGraph() {
  const { snapshot, incident } = report;
  const positions = layout(snapshot);
  const affected = new Set($('advanced-scenario').open ? incident.affectedNodeIds : []);
  const affectedEdges = new Set();
  for (const path of $('advanced-scenario').open ? incident.pathsToPosition : []) {
    for (let i = 1; i < path.length; i++) {
      for (const edge of snapshot.edges) {
        if (edge.from === path[i] && edge.to === path[i - 1]) affectedEdges.add(edge.id);
      }
    }
  }
  const svg = $('graph');
  svg.replaceChildren();
  const defs = svgElement('defs');
  for (const [id, color] of [['arrow', '#4a5e78'], ['arrow-affected', '#fb927d']]) {
    const marker = svgElement('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' });
    marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    defs.append(marker);
  }
  svg.append(defs);
  for (const edge of snapshot.edges) {
    if ($('affected-only').checked && !affectedEdges.has(edge.id)) continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const startX = from.x + 230;
    const endX = to.x - 4;
    const middle = (startX + endX) / 2;
    const d = `M ${startX} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${endX} ${to.y}`;
    const isAffected = affectedEdges.has(edge.id);
    const group = svgElement('g', { class: `edge-group${selected?.edgeId === edge.id ? ' selected' : ''}`, tabindex: 0, role: 'button', 'aria-label': `Inspect ${edge.kind} relationship` });
    group.append(svgElement('title', {}, `${edge.from} → ${edge.to}: ${edge.kind}. ${edge.evidence.status} · ${edge.evidence.sourceType}`));
    group.append(svgElement('path', { d, class: `edge-line${isAffected ? ' affected' : ''}`, 'marker-end': `url(#${isAffected ? 'arrow-affected' : 'arrow'})` }));
    group.append(svgElement('path', { d, class: 'edge-hit' }));
    const allocation = snapshot.observations?.find(item => item.entityId === edge.id && item.metric === 'allocationFraction')?.value;
    const label = edge.kind + (typeof allocation === 'number' ? ` · ${(allocation * 100).toFixed(1)}%` : edge.allocationBps == null ? '' : ` · ${edge.allocationBps / 100}%`);
    group.append(svgElement('text', { x: middle, y: (from.y + to.y) / 2 - 8, 'text-anchor': 'middle', class: 'edge-label' }, label));
    activate(group, () => select({ edgeId: edge.id }));
    svg.append(group);
  }
  for (const node of snapshot.nodes) {
    if ($('affected-only').checked && !affected.has(node.id)) continue;
    const position = positions.get(node.id);
    const group = svgElement('g', { transform: `translate(${position.x},${position.y - 44})`, class: `node ${node.kind}${affected.has(node.id) ? ' affected' : ''}${selected?.nodeId === node.id ? ' selected' : ''}`, tabindex: 0, role: 'button', 'aria-label': `Inspect ${node.label}` });
    group.append(svgElement('title', {}, node.label));
    group.append(svgElement('rect', { width: 230, height: 88 }));
    group.append(svgElement('text', { x: 14, y: 20, class: 'node-kind' }, node.kind.replaceAll('_', ' ').toUpperCase()));
    const label = node.label.replace(/^Illustrative /, '').replace(/^User holding /, '');
    const words = label.split(' ');
    const lines = [''];
    for (const word of words) {
      const last = lines.length - 1;
      if (`${lines[last]} ${word}`.trim().length > 28 && lines[last]) lines.push(word);
      else lines[last] = `${lines[last]} ${word}`.trim();
    }
    lines.slice(0, 2).forEach((line, index) => group.append(svgElement('text', { x: 14, y: 40 + index * 15, class: 'node-title' }, line)));
    group.append(svgElement('text', { x: 14, y: 75, class: 'node-status' }, snapshot.mode === 'fixture' ? 'ILLUSTRATIVE FIXTURE' : node.address ? `${node.address.slice(0, 8)}…${node.address.slice(-4)}` : node.id.slice(0, 25)));
    activate(group, () => select({ nodeId: node.id }));
    svg.append(group);
  }
  updateZoom();
}
function select(selection) {
  selected = selection;
  drawGraph();
  renderEvidence();
}
function renderEvidence() {
  const container = $('evidence');
  container.replaceChildren();
  const snapshot = report.snapshot;
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const fixture = snapshot.mode === 'fixture';
  const evidenceLabel = evidence => fixture ? 'Verified in fixture only — not on-chain' : evidence.status !== 'verified' ? evidence.status : evidence.sourceType === 'onchain_call' ? 'Verified contract read' : 'API-indexed or source-documented; see source type';
  if (selected?.edgeId) {
    const edge = snapshot.edges.find(edge => edge.id === selected.edgeId);
    $('selection-title').textContent = edge.kind;
    const facts = element('dl', undefined, 'evidence-facts');
    const entries = {
      Dependent: nodes.get(edge.from).label,
      Dependency: nodes.get(edge.to).label,
      Evidence: evidenceLabel(edge.evidence),
      Source: edge.evidence.reference,
      'Observed at': edge.evidence.observedAt,
      'Source type': edge.evidence.sourceType,
      'Source field / role': edge.evidence.sourcePath ?? edge.role ?? 'See contract read reference',
      'Source block': edge.evidence.blockNumber ?? 'Not supplied by this provider',
      ...(edge.allocationBps == null ? {} : { Allocation: `${edge.allocationBps / 100}% (fabricated snapshot value)` }),
      Notes: edge.evidence.notes
    };
    for (const [key, value] of Object.entries(entries)) facts.append(element('dt', key), element('dd', value));
    container.append(facts);
    appendObservations(container, edge.id);
    return;
  }
  if (!selected?.nodeId) return;
  const node = nodes.get(selected.nodeId);
  $('selection-title').textContent = node.label;
  const meta = element('div', undefined, 'selection-meta');
  meta.append(element('span', `ID: ${node.id}`), element('span', `Type: ${node.kind}`), element('span', fixture ? 'Illustrative fixture only' : 'Inspect each relationship for its evidence'));
  container.append(meta);
  const edges = snapshot.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  const list = element('div', undefined, 'relationship-list');
  for (const edge of edges) {
    const button = element('button', undefined, 'relationship');
    button.append(element('span', nodes.get(edge.from).label), element('strong', `${edge.kind} →`), element('span', nodes.get(edge.to).label), element('br'), element('small', evidenceLabel(edge.evidence)));
    button.addEventListener('click', () => select({ edgeId: edge.id }));
    list.append(button);
  }
  container.append(list);
  appendObservations(container, node.id);
  if (targetKinds[$('kind').value] === node.kind) {
    const button = element('button', 'Use this node as the scenario target', 'secondary');
    button.addEventListener('click', () => { $('advanced-scenario').open = true; $('target').value = node.id; $('scenario-form').requestSubmit(); });
    container.append(element('br'), button);
  }
}
function renderResult() {
  const { incident, decision } = report;
  const container = $('result');
  const fixture = report.snapshot.mode === 'fixture';
  const stress = report.stressTest;
  const status = { CALCULATED: 'Scenario calculated', MISSING_POSITION_VALUE: 'Enter a position value', BLOCKED_BY_DATA: 'Calculation needs complete, fresh vault data', LOSS_MODEL_UNAVAILABLE: 'Dollar loss needs another model' };
  container.replaceChildren(element('p', fixture ? 'SIMPLIFIED FIXTURE COMPARISON' : 'HYPOTHETICAL RESULT · YOUR ASSUMPTIONS', 'eyebrow'), element('div', fixture ? decision.action.replaceAll('_', ' ') : incident.estimatedWithdrawalUnavailable ? 'Withdrawal blocked in this scenario' : status[stress?.status] ?? 'Scenario result', `decision ${fixture ? decision.action : stress?.status === 'CALCULATED' ? 'STAY' : 'INSUFFICIENT_EVIDENCE'}`));
  if (!fixture && incident.estimatedWithdrawalUnavailable) container.append(element('p', 'EXIT UNAVAILABLE under this hypothetical chain outage. This does not establish a current outage or a permanent dollar loss.', 'explanation'));
  if (!fixture && stress?.status === 'BLOCKED_BY_DATA') {
    const reasons = element('div', undefined, 'requirements-card');
    reasons.append(element('strong', 'Why the calculation is unavailable'));
    const list = element('ul');
    for (const blocker of report.blockers ?? []) list.append(element('li', blocker.reason));
    const refresh = element('button', 'Refresh vault data and retry', 'secondary');
    refresh.disabled = report.snapshot.mode !== 'live';
    refresh.addEventListener('click', () => { refresh.disabled = true; refreshScenario(); });
    reasons.append(list, refresh); container.append(reasons);
  }
  if (!fixture && stress?.status === 'LOSS_MODEL_UNAVAILABLE') container.append(element('p', 'The graph shows which dependencies are affected. This scenario needs an additional financial model to calculate dollar losses; changing the probability cannot supply that model.', 'explanation'));
  const metrics = {
    [fixture ? 'Position value (fixture)' : report.exit?.fullExit && report.exit.positionValueUsd === report.positionUsd ? 'Position value (checked balance/reference)' : 'Assumed position value']: money(fixture ? report.snapshot.rootPositionUsd : report.positionUsd),
    'Loss if this scenario happens': money(incident.incrementalLossIfStayingUsd),
    'Expected loss (assumed probability)': money(decision.estimatedExpectedLossUsd),
    [fixture ? 'Exit cost (fixture)' : 'Your assumed exit cost']: money(fixture ? decision.exitCostUsd : stress?.assumedExitCostUsd),
    ...(fixture ? { 'Break-even probability': decision.breakEvenProbability == null ? 'Unknown' : `${(decision.breakEvenProbability * 100).toFixed(2)}%` } : {}),
    'Affected paths to position': String(incident.pathsToPosition.length)
  };
  for (const [label, value] of Object.entries(metrics)) {
    const row = element('div', undefined, 'metric');
    row.append(element('span', label), element('strong', value));
    container.append(row);
  }
  if (report.exposureUsd != null) container.append(element('p', `Affected exposure: ${money(report.exposureUsd)}. This is not a loss estimate.`, 'explanation'));
  if (report.exposureUsd != null && report.positionUsd > 0 && report.scenario.kind === 'MARKET_LOSS' && incident.incrementalLossIfStayingUsd != null) {
    container.append(element('p', `${money(report.positionUsd)} position × ${(report.exposureUsd / report.positionUsd * 100).toFixed(4)}% deployed allocation × ${(report.scenario.severityFraction * 100).toFixed(1)}% assumed lender loss = ${money(incident.incrementalLossIfStayingUsd)} conditional additional loss.`, 'explanation'));
  }
  if (stress?.comparison || report.sensitivity) {
    const comparison = stress ?? report.sensitivity;
    const sensitivity = element('div', undefined, 'sensitivity-card');
    sensitivity.append(element('p', 'ASSUMPTIONS-ONLY COMPARISON', 'eyebrow'));
    const labels = { EXIT_COST_LOWER: 'Exiting has lower modelled cost', STAY_COST_LOWER: 'Staying has lower modelled cost', EQUAL_COST: 'Modelled costs are equal' };
    sensitivity.append(element('strong', labels[comparison.comparison] ?? 'Enter a probability to compare costs'));
    sensitivity.append(element('p', `Expected additional loss: ${money(comparison.expectedLossUsd)} · Assumed exit cost: ${money(comparison.assumedExitCostUsd)}`));
    if (comparison.breakEvenProbability !== null) sensitivity.append(element('p', `Break-even probability: ${(comparison.breakEvenProbability * 100).toFixed(2)}%.${comparison.breakEvenProbability > 1 ? ' Above 100%: your assumed exit cost exceeds the scenario loss even if the event is certain.' : ''}`));
    sensitivity.append(element('p', 'This is the answer to your hypothetical example, assuming an exit is possible and avoids this loss. It does not establish an actual withdrawal or predict an incident.'));
    container.append(sensitivity);
  }
  if (!fixture) {
    const actual = element('div', undefined, 'requirements-card');
    actual.append(element('p', 'ACTUAL WITHDRAWAL · SEPARATE CHECK', 'eyebrow'));
    actual.append(element('strong', report.exit ? decision.action.replaceAll('_', ' ') : 'Not checked'));
    if (!report.exit) actual.append(element('p', 'INSUFFICIENT EVIDENCE for a real withdrawal decision. Your assumed cost above is not a checked quote. Use “Assess a public position” below to check a holder’s withdrawal.'));
    else actual.append(element('p', `Checked exit cost: ${money(decision.exitCostUsd)}. This decision remains conditional on the hypothetical scenario.`));
    container.append(actual);
  }
  if (decision.action === 'INSUFFICIENT_EVIDENCE' && report.decisionRequirements?.length) {
    const requirements = element('div', undefined, 'requirements-card');
    requirements.id = 'decision-requirements';
    requirements.append(element('strong', 'What is needed for a checked decision'));
    const list = element('ul');
    for (const requirement of report.decisionRequirements) list.append(element('li', requirement));
    requirements.append(list); container.append(requirements);
  }
  if (fixture || report.exit) container.append(element('p', decision.explanation, 'explanation'));
  const details = element('details');
  details.append(element('summary', 'Model and assumptions'));
  details.append(element('p', incident.estimationMethod));
  const list = element('ul');
  for (const caveat of incident.caveats) list.append(element('li', caveat));
  list.append(element('li', fixture ? 'Exit feasibility and costs are fixture assumptions. No real quote or withdrawal check was performed.' : report.exit ? report.exit.reasons.join(' ') : 'No current owner-specific withdrawal route has been checked.'));
  details.append(list);
  container.append(details);
  if (report.mechanisms?.length) {
    const propagation = element('details'); propagation.append(element('summary', 'How the failure can propagate'));
    for (const mechanism of report.mechanisms.slice(0, 20)) {
      const steps = element('ul');
      for (const step of mechanism.steps) {
        const dependent = report.snapshot.nodes.find(node => node.id === step.dependent)?.label;
        const dependency = report.snapshot.nodes.find(node => node.id === step.dependency)?.label;
        for (const relation of step.relationships) steps.append(element('li', `${dependency} → ${dependent} (${relation.kind}): ${relation.explanation}`));
      }
      propagation.append(steps);
    }
    container.append(propagation);
  }
}
function populateTargets() {
  const previous = $('target').value;
  $('target').replaceChildren();
  for (const node of report.snapshot.nodes.filter(node => node.kind === targetKinds[$('kind').value])) {
    const option = element('option', node.label);
    option.value = node.id;
    $('target').append(option);
  }
  if ([...$('target').options].some(option => option.value === previous)) $('target').value = previous;
  $('severity-label').hidden = !['MARKET_LOSS', 'CONTRACT_EXPLOIT'].includes($('kind').value);
  $('simulate').disabled = $('target').options.length === 0;
  if (selected) renderEvidence();
}
$('kind').addEventListener('change', populateTargets);
$('severity').addEventListener('input', () => { $('severity-value').textContent = `${$('severity').value}%`; });
$('zoom-in').addEventListener('click', () => { zoom = Math.min(zoom * 1.25, 3); updateZoom(); });
$('zoom-out').addEventListener('click', () => { zoom = Math.max(zoom / 1.25, .1); updateZoom(); });
$('fit').addEventListener('click', () => { zoom = Math.min($('graph-container').clientWidth / scene.width, $('graph-container').clientHeight / scene.height); updateZoom(); $('graph-container').scrollTo(0, 0); });
let pan;
$('graph').addEventListener('pointerdown', event => {
  if (event.target.closest('.node, .edge-group') || event.button !== 0) return;
  pan = { x: event.clientX, y: event.clientY, left: $('graph-container').scrollLeft, top: $('graph-container').scrollTop };
  $('graph').setPointerCapture(event.pointerId);
});
$('graph').addEventListener('pointermove', event => {
  if (!pan) return;
  $('graph-container').scrollLeft = pan.left - (event.clientX - pan.x);
  $('graph-container').scrollTop = pan.top - (event.clientY - pan.y);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('graph').addEventListener(name, () => { pan = undefined; });

$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report.snapshot, null, 2)], { type: 'application/json' }));
  const link = element('a');
  link.href = url;
  link.download = `${report.snapshot.mode}-dependency-graph.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function applyScenario() {
  if ($('simulate').disabled) return;
  $('simulate').disabled = true;
  $('error').textContent = '';
  const optionalNumber = id => $(id).value.trim() === '' ? null : Number($(id).value);
  const probability = optionalNumber('probability');
  const snapshotId = report.snapshot.snapshotId;
  try {
    const response = await fetch('/api/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: $('kind').value, targetNodeId: $('target').value,
        snapshotId: report.snapshot.snapshotId, positionUsd: optionalNumber('position-usd'),
        quoteId: activeQuoteId,
        severityFraction: Number($('severity').value) / 100, horizonHours: Number($('horizon').value),
        probabilityWithinHorizon: probability == null ? null : probability / 100,
        exitCostUsd: optionalNumber('exit-cost')
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (report.snapshot.snapshotId !== snapshotId) return;
    report = data;
    drawGraph();
    renderResult();
  } catch (error) { $('error').textContent = `Scenario could not be applied: ${error.message}`; }
  finally { $('simulate').disabled = false; }
}
$('scenario-form').addEventListener('submit', event => { event.preventDefault(); applyScenario(); });

async function refreshScenario() {
  const fields = ['kind', 'target', 'position-usd', 'severity', 'horizon', 'probability', 'exit-cost', 'assessment-usd'];
  const saved = Object.fromEntries(fields.map(id => [id, $(id).value]));
  const root = report.snapshot.nodes.find(n => n.id === report.snapshot.rootPositionId);
  $('chain-id').value = report.snapshot.chainId;
  $('vault-address').value = root.address;
  if (!await inspectLive()) return;
  $('kind').value = saved.kind; populateTargets();
  for (const id of fields.filter(id => !['kind', 'target'].includes(id))) $(id).value = saved[id];
  $('severity-value').textContent = `${saved.severity}%`;
  if (![...$('target').options].some(option => option.value === saved.target)) {
    $('error').textContent = 'The selected dependency is no longer in the refreshed graph. Select a new scenario target.'; return;
  }
  $('target').value = saved.target;
  if (saved['assessment-usd']) assessSnapshot(Number(saved['assessment-usd']));
  await applyScenario();
}
function showReport(data, { skipAssessment = false, preserveInputs = false } = {}) {
  const previousRoot = report?.snapshot.rootPositionId;
  report = data;
  selected = undefined;
  activeQuoteId = undefined;
  const fixture = report.snapshot.mode === 'fixture';
  const replay = report.snapshot.mode === 'historical_replay';
  $('automatic-panel').hidden = fixture;
  $('assess').disabled = fixture;
  $('assessment-result').replaceChildren();
  if (fixture) { ++assessmentSequence; $('advanced-scenario').open = true; }
  else if (skipAssessment) { ++assessmentSequence; $('assessment-result').textContent = 'Fresh graph received. Automatic price checks and exposure calculation are in progress…'; }
  else { const size = Number($('assessment-usd').value); assessSnapshot(size > 0 ? size : null); }
  $('mode-badge').textContent = fixture ? 'FIXTURE DEMO' : replay ? 'HISTORICAL RECORDING' : 'LIVE SNAPSHOT';
  $('evidence-badge').textContent = fixture ? 'FIXTURE EVIDENCE ONLY' : 'SOURCE EVIDENCE';
  $('mode-notice').textContent = fixture ? 'ILLUSTRATIVE DATA: fabricated relationships and balances for testing; no live data in this fixture.' : replay ? 'HISTORICAL RECORDING: saved provider observations, with original timestamps. Schema validation does not authenticate imported evidence. Scenarios are hypothetical; current exit decisions are disabled.' : 'LIVE SNAPSHOT: timestamped dependencies and capital allocations. Automatic price assessments and concentration proposals are available below; forecasting is experimental and execution is local-fork only. Advanced stress tests use assumed severity and probability.';
  $('quote').disabled = fixture || replay;
  $('find-holder').disabled = fixture || replay;
  $('holder-result').textContent = '';
  $('position-usd').disabled = fixture;
  if (!preserveInputs) {
    $('position-usd').value = fixture ? report.snapshot.rootPositionUsd : $('assessment-usd').value;
    $('probability').value = fixture ? '25' : '';
    $('exit-cost').value = fixture ? '200' : '';
  }
  if (previousRoot !== report.snapshot.rootPositionId) { $('owner').value = ''; $('fork-owner').value = ''; $('shares').value = ''; automationRun = null; $('run-fork').disabled = true; }
  $('exit-result').textContent = fixture ? 'Owner-specific checks are available in live mode.' : 'No owner-specific route has been checked.';
  const metadata = $('metadata');
  metadata.replaceChildren();
  for (const value of [`${report.snapshot.nodes.length} nodes · ${report.snapshot.edges.length} relationships`, `Chain ID: ${report.snapshot.chainId}`, `Mode: ${report.snapshot.mode}`, `Observed: ${report.snapshot.observedAt}`, `Block: ${report.snapshot.blockNumber ?? 'not on-chain'}`]) metadata.append(element('span', value));
  $('kind').value = report.scenario.kind;
  populateTargets();
  $('target').value = report.scenario.targetNodeId;
  $('node-search').replaceChildren();
  for (const node of report.snapshot.nodes) { const option = element('option', `${node.kind}: ${node.label}`); option.value = node.id; $('node-search').append(option); }
  $('affected-only').checked = false;
  select({ nodeId: report.snapshot.rootPositionId });
  renderResult();
  renderCoverage();
  $('simulate').disabled = $('target').options.length === 0;
  $('export').disabled = false;
  updateSelectionStatus();
}

async function assessSnapshot(positionUsd) {
  const sequence = ++assessmentSequence;
  const snapshotId = report.snapshot.snapshotId;
  $('assess').disabled = true;
  $('assessment-result').textContent = 'Calculating market allocations from the last vault inspection…';
  try {
    const response = await fetch('/api/assess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId, positionUsd }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (sequence !== assessmentSequence || report.snapshot.snapshotId !== snapshotId) return;
    renderAssessment(data, positionUsd);
  } catch (error) {
    if (sequence === assessmentSequence && report.snapshot.snapshotId === snapshotId) $('assessment-result').textContent = `Automatic checks unavailable: ${error.message}`;
  } finally {
    if (sequence === assessmentSequence && report.snapshot.snapshotId === snapshotId) $('assess').disabled = false;
  }
}
function renderAssessment(data, positionUsd) {
    const container = $('assessment-result'); container.replaceChildren();
    container.append(element('p', `Data collected ${new Date(data.observedAt).toLocaleString()}. Your amount is split across lending markets in the same proportions as the vault.`, 'explanation'));
    if (data.concentrations.length) {
      container.append(element('strong', positionUsd === null ? 'Largest market allocations — enter your amount to see dollars' : `Largest market exposures for your ${money(positionUsd)} position`));
      const list = element('ul');
      const remainder = element('details');
      const remainingList = element('ul');
      remainder.append(element('summary', `Show the other ${Math.max(0, data.concentrations.length - 5)} funded markets`), remainingList);
      for (const [index, market] of data.concentrations.entries()) {
        const item = element('li');
        const button = element('button', `${market.label}: ${(market.fraction * 100).toFixed(3)}%${market.exposureUsd === null ? '' : ` · ${money(market.exposureUsd)}`}`, 'secondary');
        button.addEventListener('click', () => { $('node-search').value = market.entityId; $('node-search').dispatchEvent(new Event('change')); });
        item.append(button); (index < 5 ? list : remainingList).append(item);
      }
      container.append(list);
      if (data.concentrations.length > 5) container.append(remainder);
    }
    if (!data.accountingUsable) container.append(element('p', 'Market amounts cannot be calculated from these data. Refresh the vault inspection; missing markets or unsupported accounting are explained below.', 'explanation'));
    container.append(element('p', 'These amounts are money exposed to a market, not money lost.', 'explanation'));
    renderForecasts(container, data.forecasts ?? []);
    const details = element('details'); details.append(element('summary', 'Data checks and limitations'));
    details.append(element('p', `${data.dependencyCount} discovered components · ${data.failedRoundChecks} failed basic oracle round checks · ${data.unknownOracleChecks} oracle checks unknown. A failed basic round check needs investigation; it does not establish an incident or loss.`));
    const list = element('ul');
    for (const check of data.oracleChecks) {
      const item = element('li', `${check.label}: ${check.status.replaceAll('_', ' ')}${check.ageSecondsAtSnapshot === null ? '' : ` · age at snapshot ${check.ageSecondsAtSnapshot}s`}`);
      if (check.evidence) item.append(element('small', ` · ${check.evidence.reference} · block ${check.evidence.blockNumber}`));
      list.append(item);
    }
    for (const unknown of data.unknowns) list.append(element('li', unknown));
    details.append(list, element('p', data.explanation)); container.append(details);
}
$('assessment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const size = Number($('assessment-usd').value);
  if (!Number.isFinite(size) || size <= 0) return;
  if (!await inspectLive({ skipAssessment: true })) return;
  $('position-usd').value = String(size);
  assessSnapshot(size);
});

function appendObservations(container, id) {
  const observations = report.snapshot.observations?.filter(item => item.entityId === id) ?? [];
  if (!observations.length) return;
  const section = element('div', undefined, 'observation-list');
  section.append(element('strong', 'Snapshot observations'));
  for (const item of observations) section.append(element('p', `${item.metric}: ${item.value ?? 'unknown'} ${item.units ?? ''} · block ${item.evidence.blockNumber ?? 'unspecified'}${item.derived ? ' · derived' : ''}`));
  container.append(section);
}
function renderCoverage() {
  const container = $('coverage'); container.replaceChildren();
  if (report.snapshot.mode === 'fixture') { container.append(element('p', 'This fixture demonstrates graph interaction and domain calculations. It does not measure discovery completeness.')); return; }
  const grid = element('div', undefined, 'coverage-grid');
  for (const [category, status] of Object.entries(report.snapshot.coverage)) { const card = element('div', category, 'coverage-item'); card.append(element('strong', status)); grid.append(card); }
  container.append(grid);
  for (const provider of report.snapshot.providerStatus) container.append(element('p', `${provider.provider}: ${provider.status}${provider.blockNumber ? ` · block ${provider.blockNumber}` : ''}${provider.message ? ` · ${provider.message}` : ''}`));
  const details = element('details'); details.append(element('summary', `${report.snapshot.unknowns.length} explicit unknowns and limitations`));
  const list = element('ul');
  for (const item of report.snapshot.unknowns) { const label = report.snapshot.nodes.find(node => node.id === item.entityId)?.label ?? item.entityId; list.append(element('li', `${item.category} · ${label}: ${item.reason}`)); }
  details.append(list); container.append(details);
}
$('affected-only').addEventListener('change', drawGraph);
$('advanced-scenario').addEventListener('toggle', () => {
  if (!report) return;
  if (!$('advanced-scenario').open) $('affected-only').checked = false;
  drawGraph();
});
$('node-search').addEventListener('change', () => {
  select({ nodeId: $('node-search').value });
  const location = layout(report.snapshot).get($('node-search').value);
  $('graph-container').scrollTo(Math.max(0, location.x * zoom - 80), Math.max(0, location.y * zoom - 180));
});
let activeInspection = 0;
async function inspectLive(options = {}) {
  const sequence = ++activeInspection;
  $('inspect').disabled = true; $('simulate').disabled = true; $('error').textContent = '';
  $('activity').textContent = 'Discovering allocations, checking contract configuration and tracing upstream dependencies…';
  try {
    const response = await fetch('/api/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selector: `${$('chain-id').value}:${$('vault-address').value.trim()}` }) });
    const job = await response.json(); if (!response.ok) throw new Error(job.error);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 700));
      if (sequence !== activeInspection) return;
      const statusResponse = await fetch(`/api/jobs/${job.jobId}`); const status = await statusResponse.json();
      if (!statusResponse.ok || status.status === 'failed') throw new Error(status.error);
      if (status.status === 'complete') { showReport(status.report, options); $('activity').textContent = `${status.report.snapshot.protocol}: ${status.report.snapshot.nodes.length} nodes and ${status.report.snapshot.edges.length} relationships. Select a node to inspect the evidence.`; return true; }
    }
    throw new Error('Inspection is taking longer than three minutes. Retry after checking provider status.');
  } catch (error) { $('activity').textContent = `Live inspection failed: ${error.message}. Use Load fixture demo for the separate illustrative example.`; return false; }
  finally { if (sequence === activeInspection) { $('inspect').disabled = false; $('simulate').disabled = !report; } }
}
$('inspect-form').addEventListener('submit', event => { event.preventDefault(); inspectLive(); });
$('example').addEventListener('change', () => {
  const [chainId, address] = $('example').value.split(':');
  $('chain-id').value = chainId; $('vault-address').value = address;
  selectionChanged();
  inspectLive();
});
$('fixture').addEventListener('click', async () => {
  ++activeInspection; $('inspect').disabled = false;
  try { await stopOwnedMonitor(); const response = await fetch('/api/demo'); if (!response.ok) throw new Error('Fixture unavailable'); showReport(await response.json()); $('activity').textContent = 'Fixture loaded explicitly. Select Inspect live vault to return to current provider data.'; }
  catch (error) { $('activity').textContent = error.message; }
});
$('recording').addEventListener('change', async () => {
  const file = $('recording').files[0];
  if (!file) return;
  ++activeInspection; $('inspect').disabled = false;
  try {
    await stopOwnedMonitor();
    if (file.size > 2_000_000) throw new Error('Recording exceeds 2 MB');
    const response = await fetch('/api/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text() });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    showReport(result); $('activity').textContent = `Saved graph loaded from ${file.name}. Acquisition time: ${result.snapshot.observedAt}. This is a hypothetical historical stress test.`;
  } catch (error) { $('activity').textContent = `Recording could not be loaded: ${error.message}`; }
  finally { $('recording').value = ''; }
});
let cursor;
async function catalogue(more = false) {
  $('load-catalogue').disabled = true;
  try {
    const response = await fetch(`/api/catalogue?chainId=${encodeURIComponent($('chain-id').value)}&version=${$('catalogue-version').value}${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    if (!more) $('catalogue').replaceChildren(element('option', 'Choose a listed vault…'));
    for (const vault of result.data) { const option = element('option', `${vault.name} · ${vault.vault_address.slice(0, 10)}…`); option.value = vault.vault_address; $('catalogue').append(option); }
    cursor = result.cursor; $('more-catalogue').hidden = !cursor;
    $('activity').textContent = `Catalogue loaded from Morpho (${result.observedAt}). Unlisted addresses can be entered directly.`;
  } catch (error) { $('activity').textContent = error.message; }
  finally { $('load-catalogue').disabled = false; }
}
$('load-catalogue').addEventListener('click', () => catalogue());
$('more-catalogue').addEventListener('click', () => catalogue(true));
$('catalogue').addEventListener('change', () => { if ($('catalogue').value.startsWith('0x')) { $('vault-address').value = $('catalogue').value; selectionChanged(); inspectLive(); } });
$('catalogue-version').addEventListener('change', () => { cursor = undefined; $('more-catalogue').hidden = true; $('catalogue').replaceChildren(element('option', 'Load the catalogue for this version…')); });
$('chain-id').addEventListener('change', () => { cursor = undefined; $('more-catalogue').hidden = true; $('catalogue').replaceChildren(element('option', 'Load the catalogue for this chain…')); });
$('exit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!report || report.snapshot.mode !== 'live') return;
  const quotedSnapshotId = report.snapshot.snapshotId;
  const quotedOwner = $('owner').value.trim(), quotedShares = $('shares').value.trim();
  activeQuoteId = undefined;
  $('quote').disabled = true; $('exit-result').textContent = 'Reading owner balances, withdrawal limits and redemption preview; estimating gas…';
  try {
    const response = await fetch('/api/quote-exit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: report.snapshot.snapshotId, owner: $('owner').value.trim(), ...($('shares').value.trim() ? { shares: $('shares').value.trim() } : {}) }) });
    const quote = await response.json(); if (!response.ok) throw new Error(quote.error);
    if (report.snapshot.snapshotId !== quotedSnapshotId || $('owner').value.trim() !== quotedOwner || $('shares').value.trim() !== quotedShares) return;
    activeQuoteId = quote.quoteId;
    $('exit-result').textContent = `Feasible: ${quote.feasible === null ? 'unknown' : quote.feasible ? 'yes, at quoted state' : 'no for this amount'} · ${quote.fullExit ? 'full balance' : 'partial / unknown'}\nEstimated cost: ${money(quote.costUsd)} · block ${quote.sourceBlock ?? 'unknown'}\n${quote.reasons.join('\n')}`;
    $('scenario-form').requestSubmit();
  } catch (error) { $('exit-result').textContent = `Redemption assessment failed: ${error.message}`; }
  finally { $('quote').disabled = report.snapshot.mode !== 'live'; }
});
$('find-holder').addEventListener('click', async () => {
  if (!report || report.snapshot.mode !== 'live') return;
  const snapshotId = report.snapshot.snapshotId;
  $('find-holder').disabled = true;
  $('holder-result').textContent = 'Finding an indexed public holder and checking its current balance…';
  try {
    const size = Number($('assessment-usd').value);
    const response = await fetch('/api/public-holder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId, ...(size > 0 ? { positionUsd: size } : {}) }) });
    const holder = await response.json(); if (!response.ok) throw new Error(holder.error);
    if (report.snapshot.snapshotId !== snapshotId) return;
    if (activeQuoteId) $('result').replaceChildren(element('p', 'Public holder changed. Check redemption again or apply the scenario without a quote.', 'explanation'));
    activeQuoteId = undefined; $('owner').value = holder.owner; $('fork-owner').value = holder.owner; $('shares').value = '';
    $('holder-result').textContent = `Public example for this vault selected; this is not your wallet. Balance verified at block ${holder.sourceBlock}${holder.requestedPositionUsd ? ` and covers ${money(holder.requestedPositionUsd)}` : ''}.`;
    $('exit-result').textContent = 'Click Check withdrawal and estimate gas to assess this holder’s full position.';
  } catch (error) { if (report.snapshot.snapshotId === snapshotId) $('holder-result').textContent = error.message; }
  finally { $('find-holder').disabled = report.snapshot.mode !== 'live'; }
});
for (const id of ['owner', 'shares']) $(id).addEventListener('input', () => {
  if (id === 'owner') $('holder-result').textContent = '';
  if (activeQuoteId) $('result').replaceChildren(element('p', 'Position changed. The previous checked decision has been cleared. Check redemption again or apply the scenario without a quote.', 'explanation'));
  activeQuoteId = undefined;
  $('exit-result').textContent = 'Position changed. Check redemption again to use a quote for this owner and amount.';
});
function updateSelectionStatus() {
  const root = report?.snapshot.nodes.find(n => n.id === report.snapshot.rootPositionId);
  const matches = root && `${report.snapshot.chainId}:${root.address?.toLowerCase()}` === selectedSelector();
  $('selection-status').textContent = root ? matches ? `Displayed graph: ${root.label} · ${root.address}` : `Selected address has changed. Displayed graph belongs to ${root.label}; fetching or starting automatic analysis will replace it.` : 'No graph loaded yet.';
}
function selectionChanged() {
  automationRun = null; activeQuoteId = undefined;
  $('run-fork').disabled = true; $('owner').value = ''; $('fork-owner').value = ''; $('shares').value = '';
  $('fork-result').replaceChildren(); $('holder-result').replaceChildren();
  updateSelectionStatus();
  if (monitorId) $('pipeline-status').textContent = 'Inputs changed. The existing monitor keeps its original configuration; Start automatic analysis restarts it with your selected vault and amount.';
}
$('vault-address').addEventListener('input', selectionChanged);
$('chain-id').addEventListener('input', selectionChanged);
$('assessment-usd').addEventListener('input', () => { automationRun = null; $('run-fork').disabled = true; if (monitorId) $('pipeline-status').textContent = 'Amount changed. Start automatic analysis to restart monitoring with this amount.'; });
try {
  const response = await fetch('/api/status'); const status = await response.json();
  if (status.appVersion !== 'automatic-flow-v2') {
    $('run-automatic').disabled = true;
    $('pipeline-status').textContent = 'The server is running an older version. Stop it with Ctrl+C, run npm run dev again, then reload this page.';
    throw new Error('Restart the old server with npm run dev to load the repaired automatic pipeline.');
  }
  $('provider-summary').textContent = `RPC ${status.rpcConfigured ? 'configured' : 'not configured'} · Source API ${status.etherscanConfigured ? 'configured' : 'not configured'}`;
  const existing = await (await fetch('/api/automation')).json();
  const monitor = existing.monitors?.[0];
  if (monitor) {
    const [chain, address] = monitor.selector.split(':'); $('chain-id').value = chain; $('vault-address').value = address;
    $('assessment-usd').value = String(monitor.positionUsd); $('destination-addresses').value = monitor.destinations.map(s => s.split(':')[1]).join('\n');
    $('limit-market').value = String(monitor.policy.maxMarketFraction * 100); $('limit-collateral').value = String(monitor.policy.maxCollateralFraction * 100); $('limit-move').value = String(monitor.policy.maxMoveFraction * 100);
    $('auto-fork').checked = monitor.autoFork;
    monitorId = monitor.id; watchedAutomationId = monitor.id; $('stop-monitor').disabled = false;
    $('activity').textContent = 'Reconnected to the running monitor.'; pollAutomation(monitor.id);
  } else await inspectLive();
} catch (error) { $('activity').textContent = `Server unavailable: ${error.message}. Run npm run dev and reload.`; }
