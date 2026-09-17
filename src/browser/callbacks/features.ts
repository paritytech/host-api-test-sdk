/**
 * Feature support probing.
 *
 * `featureSupported` ports `host-runtime.ts`'s `handleFeatureSupported`
 * genesis-hash comparison (case/`0x`-insensitive), but it answers for
 * everything `chain.connect` can actually open: the synthetic
 * `PEOPLE_GENESIS_HASH` loopback chain plus every configured network. The
 * People hash is not in `networks` — it is served in-page — so matching only
 * against `networks` told a product `false` about the one chain this host
 * always serves.
 *
 * `supportedChains` (RFC 0026) has no pre-migration analogue. It reports the
 * same People loopback, tagged `People`, plus any configured network that
 * declares its own `chain` role explicitly. `ChainIdentifier` is a fixed enum
 * (`Relay | AssetHub | People | Bulletin`) with real routing consequences, so
 * a network with no declared role is omitted rather than guessed from its
 * display name — a silently wrong label is worse than an absent one.
 *
 * Hence the deliberate asymmetry: a role-less network is routable and
 * `featureSupported` says so, but it cannot be named in `supportedChains`.
 * Everything `supportedChains` advertises is supported; the reverse does not
 * hold.
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
  const peopleGenesis = toHex(PEOPLE_GENESIS_HASH);
  /** Exactly the genesis hashes `chain.connect` routes — see that module. */
  const routable = new Set<string>([
    peopleGenesis,
    ...networks.map((network) => normalizeHash(network.genesisHash)),
  ]);

  return {
    async featureSupported(request: HostFeatureSupportedRequest): Promise<HostFeatureSupportedResponse> {
      if (request.tag !== 'Chain') {
        return { supported: false };
      }
      return { supported: routable.has(normalizeHash(request.value.genesisHash)) };
    },

    async supportedChains(): Promise<HostChainSet> {
      const chains: HostChainEntry[] = [{ identifier: 'People', genesisHash: peopleGenesis }];
      for (const network of networks) {
        if (!network.chain) continue;
        chains.push({ identifier: network.chain, genesisHash: normalizeHash(network.genesisHash) });
      }
      return { network: 'polkadot', chains };
    },
  };
}
