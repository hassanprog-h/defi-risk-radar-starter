// Fields checked against Morpho's public GraphQL introspection schema, 2026-10-11.
export const assetFields = 'address name symbol decimals price { usd timestamp }';
export const marketFields = `fragment MarketFields on Market {
  marketId irmAddress lltv morphoBlue { address }
  loanAsset { ${assetFields} } collateralAsset { ${assetFields} }
  oracle { address type data { ... on MorphoChainlinkOracleData {
    baseFeedOne { address } baseFeedTwo { address } quoteFeedOne { address } quoteFeedTwo { address }
    baseOracleVault { address }
  } } }
  state { blockNumber timestamp supplyAssets borrowAssets liquidityAssets }
}`;
export const vaultFields = `fragment VaultFields on Vault {
  address name symbol listed asset { ${assetFields} }
  chain { id network headBlock { number timestamp } }
  state { blockNumber timestamp totalAssets totalAssetsUsd totalSupply owner curator guardian timelock
    allocation { blockNumber supplyAssets supplyAssetsUsd supplyShares supplyCap
      market { ...MarketFields }
    }
  }
}`;
export const v1Query = `query InspectVault($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) { ...VaultFields }
} ${vaultFields} ${marketFields}`;
export const v2Query = `query InspectVaultV2($address: String!, $chainId: Int!) {
  vaultV2ByAddress(address: $address, chainId: $chainId) {
    address name symbol listed asset { ${assetFields} }
    chain { id network headBlock { number timestamp } }
    totalAssets totalAssetsUsd totalSupply idleAssets liquidity
    owner { address } curator { address } sentinels { sentinel { address } }
    adapters(first: 20) { pageInfo { count countTotal } items {
      address type assets assetsUsd __typename
      ... on MorphoMarketV1Adapter { positions(first: 20) { pageInfo { count countTotal } items {
        market { ...MarketFields } state { timestamp supplyAssets supplyAssetsUsd supplyShares }
      } } }
      ... on MetaMorphoAdapter { metaMorpho { ...VaultFields } }
      ... on MorphoVaultV2Adapter { innerVault { address } }
    } }
  }
} ${vaultFields} ${marketFields}`;
