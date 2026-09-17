/**
 * Feature support probing.
 *
 * `featureSupported` ports `host-runtime.ts`'s `handleFeatureSupported`
 * genesis-hash comparison (case/`0x`-insensitive). `supportedChains` (RFC
 * 0026) has no pre-migration analogue — pre-migration only ever answered the
 * single feature-support check. `network` and each entry's `identifier` are
 * best-effort until Task 11 gives `ChainRuntimeConfig` a real chain role.
 */
import type { ChainIdentifier, HostFeatureSupportedRequest, HostFeatureSupportedResponse } from '@parity/truapi';
import type { HostChainSet } from '@parity/truapi-host';
import type { ChainRuntimeConfig } from './chain.js';

function normalizeHash(value: string): `0x${string}` {
  const str = value.toLowerCase().trim();
  return (str.startsWith('0x') ? str : `0x${str}`) as `0x${string}`;
}

function identifierFor(network: ChainRuntimeConfig): ChainIdentifier {
  const name = network.name.toLowerCase();
  if (name.includes('people')) return 'People';
  if (name.includes('asset hub') || name.includes('assethub')) return 'AssetHub';
  if (name.includes('bulletin')) return 'Bulletin';
  return 'Relay';
}

export function createFeatureCallbacks(networks: ChainRuntimeConfig[]): {
  featureSupported(request: HostFeatureSupportedRequest): Promise<HostFeatureSupportedResponse>;
  supportedChains(): Promise<HostChainSet>;
} {
  return {
    async featureSupported(request: HostFeatureSupportedRequest): Promise<HostFeatureSupportedResponse> {
      if (request.tag !== 'Chain') {
        return { supported: false };
      }
      const requested = normalizeHash(request.value.genesisHash);
      const supported = networks.some((network) => normalizeHash(network.genesisHash) === requested);
      return { supported };
    },

    async supportedChains(): Promise<HostChainSet> {
      return {
        network: 'polkadot',
        chains: networks.map((network) => ({
          identifier: identifierFor(network),
          genesisHash: normalizeHash(network.genesisHash),
        })),
      };
    },
  };
}
