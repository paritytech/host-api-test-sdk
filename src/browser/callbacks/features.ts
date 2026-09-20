/**
 * Feature support probing. The two answers are deliberately asymmetric:
 * `featureSupported` covers everything `chain.connect` can open, including the
 * in-page People loopback that is not in `networks`, while `supportedChains`
 * (RFC 0026) can only name a network that declares its `ChainIdentifier` role —
 * guessing one from a display name would mislabel routing. So everything
 * `supportedChains` advertises is supported, but not the reverse.
 */
import type {
  ChainIdentifier,
  HostFeatureSupportedRequest,
  HostFeatureSupportedResponse,
} from '@parity/truapi';
import type { HostChainEntry, HostChainSet } from '@parity/truapi-host';
import { PEOPLE_GENESIS_HASH, ZERO_HASH } from '../constants.js';
import { type ChainRuntimeConfig, normalizeGenesisHash } from './chain.js';
import type { HostState } from './state.js';

/** The chain set the configured networks imply — what `supportedChains()` reports unless overridden. */
export function derivedChains(networks: readonly ChainRuntimeConfig[]): HostChainEntry[] {
  const chains: HostChainEntry[] = [
    { identifier: 'People', genesisHash: normalizeGenesisHash(PEOPLE_GENESIS_HASH) },
  ];
  for (const network of networks) {
    if (!network.chain) continue;
    chains.push({ identifier: network.chain, genesisHash: normalizeGenesisHash(network.genesisHash) });
  }
  return chains;
}

/**
 * The genesis of the first network declaring `identifier`, or the all-zero hash
 * the core reads as "this host deliberately has no such chain".
 *
 * The core routes the chains it uses internally — Bulletin for preimage
 * submission, Asset Hub for dotNS — by the genesis it was configured with, not
 * by anything `supportedChains()` reports, so this is what actually connects
 * them.
 */
export function genesisForRole(
  networks: readonly ChainRuntimeConfig[],
  identifier: ChainIdentifier,
): `0x${string}` {
  const network = networks.find((candidate) => candidate.chain === identifier);
  return normalizeGenesisHash(network?.genesisHash ?? ZERO_HASH);
}

export function createFeatureCallbacks(state: HostState, networks: ChainRuntimeConfig[]): {
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
      // Checked before the tag guard below: tags arrive over the wire, so an
      // unknown future one must still be forceable at runtime.
      const override = state.featureOverrides.get(request.tag);
      if (override !== undefined) return { supported: override };

      if (request.tag !== 'Chain') {
        return { supported: false };
      }
      return { supported: routable.has(normalizeGenesisHash(request.value.genesisHash)) };
    },

    async supportedChains(): Promise<HostChainSet> {
      return { network: 'polkadot', chains: state.supportedChainsOverride ?? derivedChains(networks) };
    },
  };
}
