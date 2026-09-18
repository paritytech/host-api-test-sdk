/**
 * Chain routing. The People genesis is served in-page by the loopback statement
 * store — that is what keeps signing local and networkless. Every other genesis
 * is matched against the configured networks and opened over real JSON-RPC
 * through `@parity/truapi-provider`.
 */
import { type ChainIdentifier, scale } from '@parity/truapi';
import type { ChainProvider, JsonRpcConnection } from '@parity/truapi-host';
import type { ChainProviderBuilder, Connection } from '@parity/truapi-provider';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { LoopbackStore } from '../loopback-chain.js';
import { createPushChannel } from './passive.js';

/** One chain this host can route by genesis hash. */
export interface ChainRuntimeConfig {
  genesisHash: string;
  rpcUrl: string;
  name: string;
  /**
   * Protocol role, if known. Leave `undefined` rather than guess — an omitted
   * network is left out of `supportedChains()` rather than mislabelled.
   */
  chain?: ChainIdentifier;
}

/**
 * The one genesis normaliser in the host, shared with `features.ts`: a second
 * one could disagree on stray whitespace and report a hash supported that
 * routing then cannot open.
 */
export const normalizeGenesisHash = (value: Uint8Array | string): `0x${string}` => {
  if (typeof value !== 'string') return scale.bytesToHex(value);
  const hex = value.trim().toLowerCase();
  return hex.startsWith('0x') ? (hex as `0x${string}`) : `0x${hex}`;
};

/** The provider keys chains by `0x`-prefixed hex, whatever spelling the config used. */
export function registerRpcChains(
  registrar: Pick<ChainProviderBuilder, 'addRpcChain'>,
  networks: readonly ChainRuntimeConfig[],
): void {
  for (const network of networks) {
    registrar.addRpcChain(normalizeGenesisHash(network.genesisHash), network.rpcUrl);
  }
}

/**
 * Memoise `load`, but forget a rejected promise so a failed wasm fetch is
 * retried on the next connect instead of becoming the page's permanent answer.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      const started = load();
      started.catch(() => {
        if (pending === started) pending = undefined;
      });
      pending = started;
    }
    return pending;
  };
}

/**
 * The provider wasm, instantiated at most once per page.
 *
 * `default` is wasm-pack's `__wbg_init`, which resolves its payload relative to
 * `import.meta.url` — hence the layout assertion in `build.mjs`. The dynamic
 * import keeps a People-only page from downloading either file, and memoising
 * stops two concurrent connects racing the glue's own init guard.
 */
const loadProviderModule = once(async () => {
  const module = await import('@parity/truapi-provider');
  await module.default();
  return module;
});

/** The provider that serves every non-People genesis this host routes. */
async function openRpcProvider(networks: readonly ChainRuntimeConfig[]) {
  const { ChainProviderBuilder } = await loadProviderModule();
  const builder = new ChainProviderBuilder();
  registerRpcChains(builder, networks);
  // `build()` consumes the builder, so it must not be freed afterwards.
  return builder.build();
}

/**
 * Draining is not optional: the provider queues frames until taken, and once
 * the backlog hits the connection's budget further `send`s fail as JSON-RPC
 * errors. `undefined` means closed or dead.
 */
async function* drainResponses(connection: Connection): AsyncGenerator<string> {
  for (;;) {
    const frame = await connection.nextResponse();
    if (frame === undefined) return;
    yield frame;
  }
}

export function createChainCallbacks(options: {
  store: LoopbackStore;
  networks: ChainRuntimeConfig[];
}): ChainProvider {
  const { store, networks } = options;
  const peopleGenesis = normalizeGenesisHash(PEOPLE_GENESIS_HASH);

  // One provider per host page, built on the first connect that needs it.
  const provider = once(() => openRpcProvider(networks));

  return {
    async connect(genesisHash: Uint8Array): Promise<JsonRpcConnection> {
      const target = normalizeGenesisHash(genesisHash);

      if (target === peopleGenesis) {
        // `onClose` ties the store subscription to the stream's life: a
        // consumer that `break`s out of `responses()` closes the channel, and
        // must take the subscription with it.
        const channel = createPushChannel<string>(() => loopback.close());
        const loopback = store.connect((json) => channel.push(json));
        // One iterator per connection: the channel mints a fresh one per call
        // over shared buffers, so two loops would race for frames.
        const iterator = channel.iterable[Symbol.asyncIterator]();
        const responses: AsyncIterable<string> = { [Symbol.asyncIterator]: () => iterator };

        return {
          send(request: string): void {
            loopback.send(request);
          },
          responses(): AsyncIterable<string> {
            return responses;
          },
          close(): void {
            // Resolves a pending pull as `done` rather than hanging it, and
            // unsubscribes via `onClose`. Idempotent.
            channel.close();
          },
        };
      }

      const network = networks.find((candidate) => normalizeGenesisHash(candidate.genesisHash) === target);
      if (!network) {
        throw new Error(`no chain configured for genesis ${target}`);
      }

      const connection = await (await provider()).connect(target);
      // One drain per connection: two loops over the pipe would race for frames.
      const responses = drainResponses(connection);

      return {
        send(request: string): void {
          connection.send(request);
        },
        responses(): AsyncIterable<string> {
          return responses;
        },
        close(): void {
          connection.close();
        },
      };
    },
  };
}
