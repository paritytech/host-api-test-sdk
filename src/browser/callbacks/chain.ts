/**
 * Chain provider — minimal router for Task 10.
 *
 * The core opens its SSO/statement-store channel by connecting to the People
 * chain; the in-page loopback store (`../loopback-chain.js`) answers that.
 * Everything else throws. Task 11 replaces this body with full multi-chain
 * WebSocket routing over `networks` and adds its own tests — do not extend
 * this file beyond the loopback route plus the throw.
 */
import type { ChainIdentifier } from '@parity/truapi';
import type { ChainProvider, JsonRpcConnection } from '@parity/truapi-host';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { LoopbackStore } from '../loopback-chain.js';
import { createPushChannel } from './passive.js';

/** One chain this host can route by genesis hash. */
export interface ChainRuntimeConfig {
  genesisHash: string;
  rpcUrl: string;
  name: string;
  /**
   * This network's protocol role, if known — consumed by
   * `features.supportedChains()`. `ChainIdentifier` is a fixed enum with
   * real routing consequences, so leave this `undefined` rather than guess:
   * an omitted network is left out of that report, not mislabeled.
   */
  chain?: ChainIdentifier;
}

function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createChainCallbacks(options: { store: LoopbackStore }): ChainProvider {
  return {
    async connect(genesisHash: Uint8Array): Promise<JsonRpcConnection> {
      if (!sameHash(genesisHash, PEOPLE_GENESIS_HASH)) {
        throw new Error('Unsupported chain: no route for this genesis hash');
      }

      // Push-to-async-iterator bridge (see passive.ts): the loopback store's
      // `onResponse` push becomes the `responses()` the core pulls.
      const channel = createPushChannel<string>();
      const loopback = options.store.connect((json) => channel.push(json));

      return {
        send(request: string): void {
          loopback.send(request);
        },
        responses(): AsyncIterable<string> {
          return channel.iterable;
        },
        close(): void {
          // Unsubscribe from the store first so no further response can
          // reach the channel, then end the channel itself so any pending
          // `responses()` pull resolves `done` instead of hanging.
          loopback.close();
          channel.close();
        },
      };
    },
  };
}
