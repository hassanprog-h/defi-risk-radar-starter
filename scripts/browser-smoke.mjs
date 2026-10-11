import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createViewerServer } from './viewer-server.mjs';

const server = createViewerServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let live;
  page.on('response', async response => {
    if (response.url().includes('/api/jobs/')) {
      try { const body = await response.json(); if (body.status === 'complete') live = body.report; } catch {}
    }
  });
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('mode-badge').textContent === 'LIVE SNAPSHOT' && document.querySelectorAll('g.node').length > 20 && !document.getElementById('inspect').disabled);
  for (let attempt = 0; !live && attempt < 20; attempt++) await page.waitForTimeout(100);
  assert.ok(live.snapshot.nodes.length > 20);
  assert.equal(await page.locator('g.node').count(), live.snapshot.nodes.length);
  assert.equal(await page.locator('g.edge-group').count(), live.snapshot.edges.length);
  assert.ok(await page.locator('#graph').boundingBox());
  for (const secret of [process.env.ETHERSCAN_API_KEY, process.env.ETHEREUM_RPC_URL]) {
    if (secret) assert.equal(JSON.stringify(live).includes(secret), false, 'Credentials must not appear in the live report');
  }
  await page.locator('#position-usd').fill('10000');
  await page.locator('#probability').fill('25');
  await page.locator('#exit-cost').fill('200');
  const exposure = live.snapshot.exposures.find(item => item.fraction > 0);
  await page.locator('#target').selectOption(exposure.marketId);
  await page.locator('#simulate').click();
  await page.waitForFunction(() => document.getElementById('simulate').disabled === false);
  assert.match(await page.locator('#result').innerText(), /INSUFFICIENT EVIDENCE/);
  await page.locator('#kind').selectOption('ORACLE_STALE');
  await page.locator('#simulate').click();
  await page.waitForFunction(() => document.getElementById('simulate').disabled === false);
  assert.match(await page.locator('#result').innerText(), /Unknown/);
  await page.locator('#kind').selectOption('CHAIN_OUTAGE');
  await page.locator('#simulate').click();
  await page.waitForFunction(() => document.getElementById('simulate').disabled === false);
  assert.match(await page.locator('#result').innerText(), /EXIT UNAVAILABLE/);
  await page.locator('#kind').selectOption('MARKET_LOSS');
  await page.locator('#target').selectOption(exposure.marketId);
  await page.locator('#simulate').click();
  await page.waitForFunction(() => document.getElementById('simulate').disabled === false);
  await page.locator('g.node.vault').first().click();
  assert.ok((await page.locator('#evidence').innerText()).includes('eip155:1:'));
  await page.screenshot({ path: '/tmp/defi-risk-radar-live.png', fullPage: true });
  await page.locator('#recording').setInputFiles(new URL('../fixtures/recordings/steakhouse-usdc.json', import.meta.url).pathname);
  await page.waitForFunction(() => document.getElementById('mode-badge').textContent === 'HISTORICAL RECORDING');
  assert.equal(await page.locator('#quote').isDisabled(), true);
  await page.locator('#position-usd').fill('10000');
  await page.locator('#simulate').click();
  await page.waitForFunction(() => document.getElementById('simulate').disabled === false);
  assert.match(await page.locator('#result').innerText(), /INSUFFICIENT EVIDENCE/);
  assert.equal((await page.locator('#result').innerText()).includes('Conditional additional loss\nUnknown'), false);
  const saved = JSON.parse(await readFile(new URL('../fixtures/recordings/steakhouse-usdc.json', import.meta.url)));
  const malformed = { ...saved, edges: [{ ...saved.edges[0], to: 'missing' }] };
  const invalidRecording = await fetch(base + '/api/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(malformed) });
  assert.equal(invalidRecording.status, 400);
  await page.locator('#example').selectOption('1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145');
  await page.locator('#inspect').click();
  await page.waitForFunction(() => document.getElementById('mode-badge').textContent === 'LIVE SNAPSHOT' && !document.getElementById('inspect').disabled);
  assert.equal(live.snapshot.protocol, 'Morpho Vault V2');
  assert.ok(live.snapshot.nodes.some(node => node.kind === 'amm'));
  assert.ok(live.snapshot.nodes.some(node => node.kind === 'yield_source'));
  await page.locator('#kind').selectOption('LIQUIDITY_SHOCK');
  await page.locator('#simulate').click();
  await page.waitForFunction(() => document.getElementById('simulate').disabled === false);
  assert.match(await page.locator('#result').innerText(), /INSUFFICIENT EVIDENCE/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Live mobile layout must not overflow');
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.screenshot({ path: '/tmp/defi-risk-radar-v2.png', fullPage: true });
  const fixtureLoaded = page.waitForResponse(response => response.url().endsWith('/api/demo'));
  await page.locator('#fixture').click(); await fixtureLoaded;
  await page.waitForFunction(() => document.getElementById('mode-badge').textContent === 'FIXTURE DEMO');
  assert.equal(await page.locator('g.node').count(), 9);
  assert.equal(await page.locator('g.edge-group').count(), 8);
  assert.match(await page.locator('#result').innerText(), /\$1,200\.00/);
  assert.equal(await page.locator('g.node.affected').count(), 3);
  await page.locator('g.edge-group').first().focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#evidence').innerText(), /Verified in fixture only/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/defi-risk-radar-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Mobile layout must not overflow the page');
  assert.deepEqual(errors, []);
  const missing = await fetch(base + '/.env'); assert.equal(missing.status, 404);
  const crossOrigin = await fetch(base + '/api/inspect', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  console.log(JSON.stringify({ browser: 'passed', liveNodes: live.snapshot.nodes.length, liveEdges: live.snapshot.edges.length, scenarios: ['market_loss', 'oracle_stale', 'chain_outage'], replay: 'passed', fixtureNodes: 9, responsive: 'passed', screenshots: ['/tmp/defi-risk-radar-live.png', '/tmp/defi-risk-radar-mobile.png'] }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
