/**
 * Chain routing.
 *
 * The People genesis is served in-page by the loopback statement store —
 * that is what keeps signing local. Product chains are matched by genesis
 * against the configured networks and opened through
 * `@parity/truapi-provider`, which owns the transport (remote JSON-RPC nodes
 * registered with `addRpcChain`) and hands back a raw string pipe.
 */
import { type ChainIdentifier, scale } from '@parity/truapi';
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

/**
 * The slice of `@parity/truapi-provider`'s `Connection` this route uses.
 *
 * Declared structurally rather than imported so the unit tests can stand in
 * a fake without instantiating a 5.2 MB wasm; the real class is checked
 * against it where `openRpcProvider` below builds one.
 */
export interface RpcConnection {
  /** Queue a JSON-RPC request string. */
  send(request: string): void;
  /** The next frame, or `undefined` once the connection is closed or dead. */
  nextResponse(): Promise<string | undefined>;
  close(): void;
}

/** The slice of `@parity/truapi-provider`'s `ChainProviderHandle` this route uses. */
export interface RpcProviderHandle {
  /** Open a connection to a chain by `0x`-prefixed genesis hash. */
  connect(genesisHash: string): Promise<RpcConnection>;
}

/** The slice of `@parity/truapi-provider`'s `ChainProviderBuilder` this route uses. */
export interface RpcChainRegistrar {
  addRpcChain(genesisHash: string, url: string): void;
}

/** Builds the provider that serves every non-People genesis this host routes. */
export type RpcProviderLoader = (
  networks: readonly ChainRuntimeConfig[],
) => Promise<RpcProviderHandle>;

/**
 * The canonical `0x`-prefixed lower-case spelling of a genesis hash, so string
 * configs and raw bytes compare equal.
 *
 * One helper, used by every genesis comparison in the host: routing here and
 * `features.ts`'s support answers. Two normalisers could disagree on a config
 * hash with stray whitespace, and a hash reported supported by one but
 * unroutable by the other is exactly the bug that invariant hides.
 */
export const normalizeGenesisHash = (value: Uint8Array | string): `0x${string}` => {
  if (typeof value !== 'string') return scale.bytesToHex(value);
  const hex = value.trim().toLowerCase();
  return hex.startsWith('0x') ? (hex as `0x${string}`) : `0x${hex}`;
};

/**
 * Register every configured network as a remote JSON-RPC chain.
 *
 * The provider keys chains by `0x`-prefixed hex, so the normalised hash is
 * prefixed back here rather than trusting whatever spelling the config used.
 */
export function registerRpcChains(
  registrar: RpcChainRegistrar,
  networks: readonly ChainRuntimeConfig[],
): void {
  for (const network of networks) {
    registrar.addRpcChain(normalizeGenesisHash(network.genesisHash), network.rpcUrl);
  }
}

/**
 * Run `load` at most once, and hand every later caller the same promise — but
 * forget a rejected one, so a failed wasm fetch is retried on the next connect
 * instead of becoming the page's permanent answer.
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
 * The module's `default` export is wasm-pack's `__wbg_init`, which resolves
 * its payload with `new URL('truapi_provider_bg.wasm', import.meta.url)` —
 * hence the build-time assertion in `build.mjs` that the glue lands in the
 * directory the `.wasm` is copied into. The import itself is dynamic and the
 * result is memoised, so a page that only ever talks to the People loopback
 * never downloads either the glue or the payload, and two concurrent connects
 * share one instantiation instead of racing the glue's own `wasm !== undefined`
 * guard.
 */
const loadProviderModule = once(async () => {
  const module = await import('@parity/truapi-provider');
  await module.default();
  return module;
});

/** Default `RpcProviderLoader`: the real wasm provider, built from the config. */
const openRpcProvider: RpcProviderLoader = async (networks) => {
  const { ChainProviderBuilder } = await loadProviderModule();
  const builder = new ChainProviderBuilder();
  registerRpcChains(builder, networks);
  // `build()` consumes the builder, so it must not be freed afterwards.
  return builder.build();
};

/**
 * Pull loop over a provider connection.
 *
 * Draining is not optional: the provider queues frames until they are taken,
 * and once the backlog hits the connection's budget further `send` calls come
 * back as JSON-RPC errors. `undefined` means closed or dead, which ends the
 * iteration the core is running.
 */
async function* drainResponses(connection: RpcConnection): AsyncGenerator<string> {
  for (;;) {
    const frame = await connection.nextResponse();
    if (frame === undefined) return;
    yield frame;
  }
}

export function createChainCallbacks(options: {
  store: LoopbackStore;
  networks: ChainRuntimeConfig[];
  /**
   * Override for the provider behind the configured-network route. Exists so
   * the unit tests can exercise that route without a wasm instantiation or a
   * socket; production leaves it unset.
   */
  openRpcProvider?: RpcProviderLoader;
}): ChainProvider {
  const { store, networks } = options;
  const peopleGenesis = normalizeGenesisHash(PEOPLE_GENESIS_HASH);
  const load = options.openRpcProvider ?? openRpcProvider;

  // One provider per host page, built on the first connect that needs it.
  const provider = once(() => load(networks));

  return {
    async connect(genesisHash: Uint8Array): Promise<JsonRpcConnection> {
      const target = normalizeGenesisHash(genesisHash);

      if (target === peopleGenesis) {
        // Push-to-async-iterator bridge (see passive.ts): the loopback store's
        // `onResponse` push becomes the `responses()` the core pulls.
        // `onClose` is what ties the store subscription to the stream's life:
        // a consumer that `break`s out of `responses()` calls the iterator's
        // `return()`, which closes the channel — and must take the
        // subscription with it rather than leave it feeding a dead channel.
        const channel = createPushChannel<string>(() => loopback.close());
        const loopback = store.connect((json) => channel.push(json));
        // One iterator per connection, not one per `responses()` call: the
        // channel's `[Symbol.asyncIterator]` mints a fresh iterator over shared
        // buffers, so two loops would race each other for frames. The RPC route
        // below gets this from its generator; this route pins it explicitly.
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
            // Closing the channel stops any further response reaching it,
            // resolves a pending `responses()` pull as `done` instead of
            // hanging it, and runs `onClose` — which unsubscribes from the
            // store. Closing twice is a no-op on both sides.
            channel.close();
          },
        };
      }

      const network = networks.find((candidate) => normalizeGenesisHash(candidate.genesisHash) === target);
      if (!network) {
        throw new Error(`no chain configured for genesis ${target}`);
      }

      // No bridge on this route: the provider's `Connection` is already the
      // raw string pipe the core's `JsonRpcConnection` asks for, so neither a
      // push channel nor a JSON (de)serialisation step is needed.
      const connection = await (await provider()).connect(target);
      // One drain per connection, not one per `responses()` call: two loops
      // over the same pipe would race each other for frames.
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
