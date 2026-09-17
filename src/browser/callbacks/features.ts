/**
 * Feature support probing.
 *
 * `featureSupported` ports `host-runtime.ts`'s `handleFeatureSupported`
 * genesis-hash comparison (case/`0x`-insensitive). `supportedChains` (RFC
 * 0026) has no pre-migration analogue. It reports exactly what `chain.ts`
 * can actually serve: the synthetic `PEOPLE_GENESIS_HASH` loopback chain,
 * tagged `People` (the same hash `chain.connect` answers), plus any
 * configured network that declares its own `chain` role explicitly.
 * `ChainIdentifier` is a fixed enum (`Relay | AssetHub | People | Bulletin`)
 * with real routing consequences, so a network with no declared role is
 * omitted rather than guessed from its display name — a silently wrong
 * label is worse than an absent one.
 */
import type { HostFeatureSupportedRequest, HostFeatureSupportedResponse } from '@parity/truapi';
import type { HostChainEntry, HostChainSet } from '@parity/truapi-host';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { ChainRuntimeConfig } from './chain.js';

function normalizeHash(value: string): `0x${string}` {
  const str = value.toLowerCase().trim();
  return (str.startsWith('0x') ? str : `0x${str}`) as `0x${string}`;
}

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;

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
      const chains: HostChainEntry[] = [{ identifier: 'People', genesisHash: toHex(PEOPLE_GENESIS_HASH) }];
      for (const network of networks) {
        if (!network.chain) continue;
        chains.push({ identifier: network.chain, genesisHash: normalizeHash(network.genesisHash) });
      }
      return { network: 'polkadot', chains };
    },
  };
}
