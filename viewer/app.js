const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const money = value => value == null ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const targetKinds = { MARKET_LOSS: 'lending_market', ORACLE_STALE: 'oracle', CHAIN_OUTAGE: 'chain', ASSET_DEPEG: 'asset', CONTRACT_EXPLOIT: 'vault', LIQUIDITY_SHOCK: 'amm' };
let report;
let selected;
let activeQuoteId;
let zoom = .85;
let scene = { width: 1200, height: 660 };

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
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
  const affected = new Set(incident.affectedNodeIds);
  const affectedEdges = new Set();
  for (const path of incident.pathsToPosition) {
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
    button.addEventListener('click', () => { $('target').value = node.id; $('scenario-form').requestSubmit(); });
    container.append(element('br'), button);
  }
}
function renderResult() {
  const { incident, decision } = report;
  const container = $('result');
  const fixture = report.snapshot.mode === 'fixture';
  container.replaceChildren(element('p', fixture ? 'SIMPLIFIED FIXTURE COMPARISON' : 'MODELLED IMPACT · CONDITIONAL DECISION', 'eyebrow'), element('div', decision.action.replaceAll('_', ' '), `decision ${decision.action}`));
  const metrics = {
    [fixture ? 'Position value (fixture)' : report.exit?.fullExit && report.exit.positionValueUsd === report.positionUsd ? 'Position value (checked balance/reference)' : 'Assumed position value']: money(fixture ? report.snapshot.rootPositionUsd : report.positionUsd),
    'Conditional additional loss': money(incident.incrementalLossIfStayingUsd),
    'Expected loss (assumed probability)': money(decision.estimatedExpectedLossUsd),
    'Exit cost': money(decision.exitCostUsd),
    'Break-even probability': decision.breakEvenProbability == null ? 'Unknown' : `${(decision.breakEvenProbability * 100).toFixed(2)}%`,
    'Affected paths to position': String(incident.pathsToPosition.length)
  };
  for (const [label, value] of Object.entries(metrics)) {
    const row = element('div', undefined, 'metric');
    row.append(element('span', label), element('strong', value));
    container.append(row);
  }
  if (report.exposureUsd != null) container.append(element('p', `Affected exposure: ${money(report.exposureUsd)}. This is not a loss estimate.`, 'explanation'));
  if (report.sensitivity) container.append(element('p', `Assumed-cost sensitivity: break-even probability ${(report.sensitivity.breakEvenProbability * 100).toFixed(2)}%. No verified exit decision follows from this assumption.`, 'explanation'));
  container.append(element('p', decision.explanation, 'explanation'));
  for (const blocker of report.blockers ?? []) container.append(element('p', `Estimate withheld · ${blocker.category}: ${blocker.reason}`, 'explanation'));
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
$('scenario-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('simulate').disabled) return;
  $('simulate').disabled = true;
  $('error').textContent = '';
  const optionalNumber = id => $(id).value.trim() === '' ? null : Number($(id).value);
  const probability = optionalNumber('probability');
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
    report = data;
    drawGraph();
    renderResult();
  } catch (error) { $('error').textContent = `Scenario could not be applied: ${error.message}`; }
  finally { $('simulate').disabled = false; }
});
function showReport(data) {
  report = data;
  selected = undefined;
  activeQuoteId = undefined;
  const fixture = report.snapshot.mode === 'fixture';
  const replay = report.snapshot.mode === 'historical_replay';
  $('mode-badge').textContent = fixture ? 'FIXTURE DEMO' : replay ? 'HISTORICAL RECORDING' : 'LIVE SNAPSHOT';
  $('evidence-badge').textContent = fixture ? 'FIXTURE EVIDENCE ONLY' : 'SOURCE EVIDENCE';
  $('mode-notice').textContent = fixture ? 'ILLUSTRATIVE DATA: fabricated relationships and balances for testing; no live data in this fixture.' : replay ? 'HISTORICAL RECORDING: saved provider observations, with original timestamps. Schema validation does not authenticate imported evidence. Scenarios are hypothetical; current exit decisions are disabled.' : 'LIVE DEPENDENCIES: timestamped provider observations. Failures, severity, USD size and probability are hypothetical assumptions. Coverage gaps are listed below.';
  $('quote').disabled = fixture || replay;
  $('position-usd').disabled = fixture;
  $('position-usd').value = fixture ? report.snapshot.rootPositionUsd : '';
  $('probability').value = fixture ? '25' : '';
  $('exit-cost').value = fixture ? '200' : '';
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
  $('simulate').disabled = false;
  $('export').disabled = false;
}

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
$('node-search').addEventListener('change', () => {
  select({ nodeId: $('node-search').value });
  const location = layout(report.snapshot).get($('node-search').value);
  $('graph-container').scrollTo(Math.max(0, location.x * zoom - 80), Math.max(0, location.y * zoom - 180));
});
let activeInspection = 0;
async function inspectLive() {
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
      if (status.status === 'complete') { showReport(status.report); $('activity').textContent = `${status.report.snapshot.protocol}: ${status.report.snapshot.nodes.length} nodes and ${status.report.snapshot.edges.length} relationships. Select a node to inspect the evidence.`; return; }
    }
    throw new Error('Inspection is taking longer than three minutes. Retry after checking provider status.');
  } catch (error) { $('activity').textContent = `Live inspection failed: ${error.message}. Use Load fixture demo for the separate illustrative example.`; }
  finally { if (sequence === activeInspection) { $('inspect').disabled = false; $('simulate').disabled = !report; } }
}
$('inspect-form').addEventListener('submit', event => { event.preventDefault(); inspectLive(); });
$('example').addEventListener('change', () => {
  const [chainId, address] = $('example').value.split(':');
  $('chain-id').value = chainId; $('vault-address').value = address;
  $('activity').textContent = 'Example selected. Inspect live vault rebuilds its graph from provider data.';
});
$('fixture').addEventListener('click', async () => {
  ++activeInspection; $('inspect').disabled = false;
  try { const response = await fetch('/api/demo'); if (!response.ok) throw new Error('Fixture unavailable'); showReport(await response.json()); $('activity').textContent = 'Fixture loaded explicitly. Select Inspect live vault to return to current provider data.'; }
  catch (error) { $('activity').textContent = error.message; }
});
$('recording').addEventListener('change', async () => {
  const file = $('recording').files[0];
  if (!file) return;
  ++activeInspection; $('inspect').disabled = false;
  try {
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
$('catalogue').addEventListener('change', () => { if ($('catalogue').value.startsWith('0x')) $('vault-address').value = $('catalogue').value; });
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
for (const id of ['owner', 'shares']) $(id).addEventListener('input', () => {
  activeQuoteId = undefined;
  $('exit-result').textContent = 'Position changed. Check redemption again to use a quote for this owner and amount.';
});
try {
  const response = await fetch('/api/status'); const status = await response.json();
  $('provider-summary').textContent = `RPC ${status.rpcConfigured ? 'configured' : 'not configured'} · Source API ${status.etherscanConfigured ? 'configured' : 'not configured'}`;
  await inspectLive();
} catch (error) { $('activity').textContent = `Server unavailable: ${error.message}. Run npm run dev and reload.`; }
