/**
 * Chain routing.
 *
 * The People genesis is served in-page by the loopback statement store —
 * that is what keeps signing local. Product chains are matched by genesis
 * against the configured networks and opened over WebSocket.
 */
import { getWsRawProvider } from 'polkadot-api/ws';
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

/** Hex-normalise a genesis hash so string configs and raw bytes compare equal. */
const normalize = (value: Uint8Array | string): string => {
  if (typeof value === 'string') {
    return (value.startsWith('0x') ? value.slice(2) : value).toLowerCase();
  }
  return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
};

export function createChainCallbacks(options: {
  store: LoopbackStore;
  networks: ChainRuntimeConfig[];
}): ChainProvider {
  const { store, networks } = options;
  const peopleGenesis = normalize(PEOPLE_GENESIS_HASH);

  return {
    async connect(genesisHash: Uint8Array): Promise<JsonRpcConnection> {
      const target = normalize(genesisHash);

      if (target === peopleGenesis) {
        // Push-to-async-iterator bridge (see passive.ts): the loopback store's
        // `onResponse` push becomes the `responses()` the core pulls.
        const channel = createPushChannel<string>();
        const loopback = store.connect((json) => channel.push(json));

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
      }

      const network = networks.find((candidate) => normalize(candidate.genesisHash) === target);
      if (!network) {
        throw new Error(`no chain configured for genesis 0x${target}`);
      }

      // Same bridge as the loopback route: the raw WS provider pushes
      // messages, the core pulls them via `responses()`.
      const channel = createPushChannel<string>();
      // `getWsRawProvider` exchanges parsed JSON-RPC objects, not strings
      // (confirmed against the installed `@polkadot-api/ws-provider`
      // implementation, which does `JSON.parse`/`JSON.stringify` at the
      // socket boundary) — the core's `JsonRpcConnection` contract is
      // string-based, so the (de)serialisation happens right here.
      const socket = getWsRawProvider(network.rpcUrl)((message) =>
        channel.push(JSON.stringify(message)),
      );

      return {
        send(request: string): void {
          socket.send(JSON.parse(request));
        },
        responses(): AsyncIterable<string> {
          return channel.iterable;
        },
        close(): void {
          // Same ordering as the loopback route: stop the socket from
          // feeding the channel before ending it.
          socket.disconnect();
          channel.close();
        },
      };
    },
  };
}
