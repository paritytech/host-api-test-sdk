import { describe, expect, it } from 'vitest';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { ChainRuntimeConfig } from './chain.js';
import { createFeatureCallbacks } from './features.js';

const PEOPLE_HEX = `0x${Array.from(PEOPLE_GENESIS_HASH, (b) => b.toString(16).padStart(2, '0')).join('')}` as const;
const PEOPLE_HEX_UPPER = `0x${PEOPLE_HEX.slice(2).toUpperCase()}` as const;

const ROLELESS_HEX = `0x${'ab'.repeat(32)}` as const;
const ROLELESS: ChainRuntimeConfig = {
  genesisHash: ROLELESS_HEX,
  rpcUrl: 'wss://example.invalid',
  name: 'Roleless',
};

const WITH_ROLE: ChainRuntimeConfig = { ...ROLELESS, chain: 'AssetHub' };

describe('feature support', () => {
  it('reports the People chain it advertises as supported', async () => {
    const features = createFeatureCallbacks([]);

    // The regression: `supportedChains()` always names the People loopback, so
    // `featureSupported` must not answer `false` for the same hash. The People
    // genesis is served in-page and is never in `networks`.
    const advertised = (await features.supportedChains()).chains.map((chain) => chain.genesisHash);
    expect(advertised).toContain(PEOPLE_HEX);

    for (const spelling of [PEOPLE_HEX, PEOPLE_HEX_UPPER] as const) {
      const response = await features.featureSupported({
        tag: 'Chain',
        value: { genesisHash: spelling },
      });
      expect(response.supported).toBe(true);
    }
  });

  it('reports a configured network as supported even without a declared role', async () => {
    const features = createFeatureCallbacks([ROLELESS]);

    expect(
      (await features.featureSupported({ tag: 'Chain', value: { genesisHash: ROLELESS_HEX } }))
        .supported,
    ).toBe(true);
    // ...but it is still left out of the advertised set rather than mislabelled.
    expect((await features.supportedChains()).chains).toEqual([
      { identifier: 'People', genesisHash: PEOPLE_HEX },
    ]);
  });

  it('advertises a network that declares its role', async () => {
    const features = createFeatureCallbacks([WITH_ROLE]);
    expect((await features.supportedChains()).chains).toEqual([
      { identifier: 'People', genesisHash: PEOPLE_HEX },
      { identifier: 'AssetHub', genesisHash: ROLELESS_HEX },
    ]);
  });

  it('denies a genesis no route serves', async () => {
    const features = createFeatureCallbacks([WITH_ROLE]);
    expect(
      (await features.featureSupported({
        tag: 'Chain',
        value: { genesisHash: `0x${'00'.repeat(32)}` },
      })).supported,
    ).toBe(false);
  });
});
