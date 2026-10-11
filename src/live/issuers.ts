import { GraphBuilder } from './builder.js';

// Identity registry from official issuer documentation, reviewed 2026-10-11.
// Address matching establishes documented identity, not current reserve sufficiency.
const circleUsdc: Record<number, string> = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
};
export function discoverDocumentedIssuers(builder: GraphBuilder) {
  const asset = builder.finish().nodes.find(node => node.address === circleUsdc[builder.snapshot.chainId]);
  if (!asset) return;
  const issuer = builder.node('issuer:circle:usdc', 'issuer', 'Circle · USDC issuer');
  builder.edge(asset.id, issuer, 'BACKED_BY', {
    status: 'verified', sourceType: 'documentation', verification: 'documentation_only',
    reference: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
    sourcePath: `Mainnet.${builder.snapshot.chainId === 1 ? 'Ethereum' : 'Base'}`,
    observedAt: builder.snapshot.observedAt,
    notes: 'Official documented USDC identity and issuer backing relationship, reviewed 2026-10-11. Current reserves, custodians, redemption eligibility and issuer solvency have not been independently verified.'
  });
  builder.snapshot.coverage.issuer = 'partial';
  builder.unknown(issuer, 'issuer', 'Documented issuer identity is established; reserve composition, custody and redemption restrictions require off-chain evidence.');
}
