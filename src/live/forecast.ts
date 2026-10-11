import { predictDepeg, type DepegModel } from '../forecast/depeg.js';
import { PriceClient, stablecoinRegistry } from '../connectors/prices.js';
import type { LiveSnapshot } from './types.js';
import { assessDependencies } from './assess.js';

export async function forecastDependencies(snapshot: LiveSnapshot, positionUsd: number | null, model: DepegModel | null, prices: PriceClient, now = Date.now()) {
  const assessment = assessDependencies(snapshot, positionUsd, now);
  const rootAsset = snapshot.edges.find(e => e.from === snapshot.rootPositionId && e.kind === 'ACCOUNTING_ASSET' && e.evidence.status === 'verified')?.to;
  const reachable = new Set([snapshot.rootPositionId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of snapshot.edges) if (e.evidence.status === 'verified' && reachable.has(e.from) && !reachable.has(e.to)) { reachable.add(e.to); changed = true; }
  }
  const assets = Object.entries(stablecoinRegistry).filter(([id]) => reachable.has(id));
  const end = Math.floor(now / 3_600_000) * 3600;
  const forecasts = await Promise.all(assets.map(async ([assetId, product]) => {
    const base = { assetId, symbol: product.symbol, role: assetId === rootAsset ? 'ACCOUNTING_ASSET' : 'DOWNSTREAM_DEPENDENCY', lossMechanism: assetId === rootAsset ? 'USD mark-to-market price change of underlying units, assuming constant vault assets per share; not lender bad debt.' : 'Collateral/backing price monitoring only; borrower liquidation/recovery model required for a lender-loss forecast.' };
    if (!model || snapshot.mode !== 'live') return { ...base, status: model ? 'HISTORICAL_SNAPSHOT' : 'MODEL_NOT_AVAILABLE', probabilityWithinHorizon: null, expectedUsdMarkDownside: null };
    try {
      const history = await prices.history(product.provider, product.product, end - 72 * 3600, end);
      const forecast = predictDepeg(model, history.candles, now / 1000);
      return { ...base, ...forecast, source: history.source, retrievedAt: history.retrievedAt,
        expectedUsdMarkDownside: assetId === rootAsset && assessment.accountingUsable && positionUsd !== null && forecast.expectedTerminalDownsideFraction !== null ? positionUsd * forecast.expectedTerminalDownsideFraction : null };
    } catch { return { ...base, status: 'PRICE_PROVIDER_UNAVAILABLE', probabilityWithinHorizon: null, expectedUsdMarkDownside: null }; }
  }));
  return { ...assessment, assessmentKind: 'DEPENDENCY_MEASUREMENTS_AND_EXPERIMENTAL_PRICE_FORECASTS', forecasts,
    forecast: { ...assessment.forecast, status: 'PORTFOLIO_LOSS_MODEL_UNAVAILABLE', explanation: 'The per-dependency price models below are separate from a joint portfolio incident/lender-loss forecast, which remains unavailable.' },
    forecastCoverage: { supportedEvent: 'Further stablecoin USD price depeg', unsupported: ['Security exploits', 'Borrower bad debt', 'Chain outages', 'Oracle compromise', 'Bridge recovery'], executionValidated: false },
    unknowns: assessment.unknowns.filter(u => !u.startsWith('No calibrated')).concat('Price-regime estimates are an experimental historical baseline; rare-event calibration and current regime transfer are unproven.') };
}
