import type { NetworkConfig, HexString } from './types.js';

export const PASEO_ASSET_HUB: NetworkConfig = {
  id: 'paseo-asset-hub',
  name: 'Paseo Asset Hub',
  genesisHash: '0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6' as HexString,
  rpcUrl: 'wss://paseo-asset-hub-next-rpc.polkadot.io',
  tokenSymbol: 'PAS',
  tokenDecimals: 10,
};

export const PREVIEWNET: NetworkConfig = {
  id: 'previewnet',
  name: 'Previewnet',
  genesisHash: '0x8c27ddf678c2ae9bef0efebfc485a9309f3d735c6d3fbb8d947afc3ace0e80f4' as HexString,
  rpcUrl: 'wss://previewnet.substrate.dev/relay/alice',
  tokenSymbol: 'UNIT',
  tokenDecimals: 12,
};

export const PREVIEWNET_ASSET_HUB: NetworkConfig = {
  id: 'previewnet-asset-hub',
  name: 'Previewnet Asset Hub',
  genesisHash: '0x4d11c803cc6921429e3876638977ad006ea1bba8cd3976a0bca2f164e7026210' as HexString,
  rpcUrl: 'wss://previewnet.substrate.dev/asset-hub',
  tokenSymbol: 'UNIT',
  tokenDecimals: 12,
};

export const DEFAULT_CHAIN = PASEO_ASSET_HUB;

export const SUPPORTED_CHAINS: NetworkConfig[] = [
  PASEO_ASSET_HUB,
  PREVIEWNET,
  PREVIEWNET_ASSET_HUB,
];
