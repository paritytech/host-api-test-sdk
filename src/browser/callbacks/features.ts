/**
 * Feature support probing. The two answers are deliberately asymmetric:
 * `featureSupported` covers everything `chain.connect` can open, including the
 * in-page People loopback that is not in `networks`, while `supportedChains`
 * (RFC 0026) can only name a network that declares its `ChainIdentifier` role —
 * guessing one from a display name would mislabel routing. So everything
 * `supportedChains` advertises is supported, but not the reverse.
 */
import type { HostFeatureSupportedRequest, HostFeatureSupportedResponse } from '@parity/truapi';
import type { HostChainEntry, HostChainSet } from '@parity/truapi-host';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import { type ChainRuntimeConfig, normalizeGenesisHash } from './chain.js';

export function createFeatureCallbacks(networks: ChainRuntimeConfig[]): {
  featureSupported(request: HostFeatureSupportedRequest): Promise<HostFeatureSupportedResponse>;
  supportedChains(): Promise<HostChainSet>;
} {
  const peopleGenesis = normalizeGenesisHash(PEOPLE_GENESIS_HASH);
  /** Exactly the genesis hashes `chain.connect` routes — see that module. */
  const routable = new Set<string>([
    peopleGenesis,
    ...networks.map((network) => normalizeGenesisHash(network.genesisHash)),
  ]);

  return {
    async featureSupported(request: HostFeatureSupportedRequest): Promise<HostFeatureSupportedResponse> {
      if (request.tag !== 'Chain') {
        return { supported: false };
      }
      return { supported: routable.has(normalizeGenesisHash(request.value.genesisHash)) };
    },

    async supportedChains(): Promise<HostChainSet> {
      const chains: HostChainEntry[] = [{ identifier: 'People', genesisHash: peopleGenesis }];
      for (const network of networks) {
        if (!network.chain) continue;
        chains.push({ identifier: network.chain, genesisHash: normalizeGenesisHash(network.genesisHash) });
      }
      return { network: 'polkadot', chains };
    },
  };
}
