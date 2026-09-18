import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { LoopbackStore } from '../loopback-chain.js';
import { createLoopbackStore } from '../loopback-chain.js';
import type { ChainRuntimeConfig } from './chain.js';
import { createChainCallbacks, registerRpcChains } from './chain.js';

/**
 * A stand-in for `@parity/truapi-provider`: a raw string pipe whose
 * `nextResponse()` hands out queued frames and then `undefined`, the way the
 * real `Connection` does once it is closed or dead. No wasm, no socket.
 *
 * `vi.hoisted` is what lets a test steer it — `vi.mock` is hoisted above every
 * import, so the factory can only close over state declared this way.
 */
const wasm = vi.hoisted(() => ({
  /** Frames the next connection hands out, in order. */
  frames: [] as string[],
  /** Genesis hashes `connect` was asked for. */
  asked: [] as string[],
  /** Requests the last connection was sent. */
  sent: [] as string[],
  /** Chains registered on the builder. */
  registered: [] as Array<[string, string]>,
  /** How many providers were built. */
  built: 0,
  /** Whether the last connection was closed. */
  closed: false,
}));

vi.mock('@parity/truapi-provider', () => ({
  default: async () => {},
  ChainProviderBuilder: class {
    addRpcChain(genesisHash: string, url: string) {
      wasm.registered.push([genesisHash, url]);
    }
    build() {
      wasm.built += 1;
      return {
        connect: async (genesisHash: string) => {
          wasm.asked.push(genesisHash);
          const queue = [...wasm.frames];
          return {
            send: (request: string) => wasm.sent.push(request),
            nextResponse: async () => queue.shift(),
            close: () => {
              wasm.closed = true;
            },
          };
        },
      };
    }
  },
}));

beforeEach(() => {
  wasm.frames = [];
  wasm.asked = [];
  wasm.sent = [];
  wasm.registered = [];
  wasm.built = 0;
  wasm.closed = false;
});

/** A store that records how often the connection it handed out was closed. */
function storeSpy(): { store: LoopbackStore; closes: () => number } {
  const close = vi.fn();
  return {
    store: {
      connect: () => ({ send() {}, close }),
      publish() {},
      onSubmit: () => () => {},
    },
    closes: () => close.mock.calls.length,
  };
}

describe('chain routing', () => {
  it('routes the People genesis to the loopback store', async () => {
    const store = createLoopbackStore();
    const provider = createChainCallbacks({ store, networks: [] });
    const connection = await provider.connect(PEOPLE_GENESIS_HASH);
    const responses = connection.responses()[Symbol.asyncIterator]();

    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'statement_submit', params: ['0x00'] }),
    );
    // The loopback answers every request, so a response must arrive.
    const { value } = await responses.next();
    expect(JSON.parse(value as string).id).toBe(1);
    connection.close();
  });

  it('ends the response stream on close', async () => {
    const provider = createChainCallbacks({ store: createLoopbackStore(), networks: [] });
    const connection = await provider.connect(PEOPLE_GENESIS_HASH);
    const responses = connection.responses()[Symbol.asyncIterator]();
    connection.close();
    expect((await responses.next()).done).toBe(true);
  });

  it('serves one response iterator per connection, not one per call', async () => {
    const provider = createChainCallbacks({ store: createLoopbackStore(), networks: [] });
    const connection = await provider.connect(PEOPLE_GENESIS_HASH);

    // Two iterators over the same push channel would race each other for
    // frames — each response would reach exactly one of them. The configured-
    // network route gets this from its generator; this one must match it.
    const first = connection.responses()[Symbol.asyncIterator]();
    const second = connection.responses()[Symbol.asyncIterator]();
    expect(second).toBe(first);
    connection.close();
  });

  it('unsubscribes from the store when the consumer stops pulling', async () => {
    const { store, closes } = storeSpy();
    const provider = createChainCallbacks({ store, networks: [] });
    const connection = await provider.connect(PEOPLE_GENESIS_HASH);

    // `for await ... break` ends with the iterator's `return()`. Without an
    // `onClose` the channel would close and the store subscription would stay
    // behind, feeding nothing.
    await connection.responses()[Symbol.asyncIterator]().return?.();
    expect(closes()).toBe(1);
  });

  it('unsubscribes from the store on close', async () => {
    const { store, closes } = storeSpy();
    const provider = createChainCallbacks({ store, networks: [] });
    const connection = await provider.connect(PEOPLE_GENESIS_HASH);

    connection.close();
    // Closing twice is a no-op rather than a second unsubscribe.
    connection.close();
    expect(closes()).toBe(1);
  });

  it('rejects a genesis hash no network declares', async () => {
    const provider = createChainCallbacks({ store: createLoopbackStore(), networks: [] });
    await expect(provider.connect(new Uint8Array(32).fill(9))).rejects.toThrow(
      /no chain configured/i,
    );
  });
});

describe('configured-network routing', () => {
  const NETWORK: ChainRuntimeConfig = {
    name: 'previewnet',
    genesisHash: '0x' + 'ab'.repeat(32),
    rpcUrl: 'wss://previewnet.example/relay',
  };

  it('registers every configured network by 0x-prefixed genesis hash', () => {
    const registered: Array<[string, string]> = [];
    registerRpcChains({ addRpcChain: (hash, url) => registered.push([hash, url]) }, [
      NETWORK,
      // Unprefixed and upper-case in the config: the provider still has to see
      // the canonical 0x-prefixed lower-case spelling.
      { name: 'other', genesisHash: 'CD'.repeat(32), rpcUrl: 'wss://other.example' },
    ]);

    expect(registered).toEqual([
      [`0x${'ab'.repeat(32)}`, 'wss://previewnet.example/relay'],
      [`0x${'cd'.repeat(32)}`, 'wss://other.example'],
    ]);
  });

  it('routes a configured genesis to the provider and pipes frames both ways', async () => {
    wasm.frames = ['{"id":1}', '{"id":2}'];
    const provider = createChainCallbacks({ store: createLoopbackStore(), networks: [NETWORK] });

    const opened = await provider.connect(Uint8Array.from({ length: 32 }, () => 0xab));
    expect(wasm.asked).toEqual([`0x${'ab'.repeat(32)}`]);
    // The provider is built from the configured networks, not from thin air.
    expect(wasm.registered).toEqual([[`0x${'ab'.repeat(32)}`, 'wss://previewnet.example/relay']]);

    opened.send('{"id":1,"method":"chainSpec_v1_genesisHash"}');
    expect(wasm.sent).toEqual(['{"id":1,"method":"chainSpec_v1_genesisHash"}']);

    // `responses()` is a pull loop over `nextResponse()`, and the queue above
    // runs dry — which is how the provider reports a closed or dead pipe.
    const received: string[] = [];
    for await (const frame of opened.responses()) received.push(frame);
    expect(received).toEqual(['{"id":1}', '{"id":2}']);

    opened.close();
    expect(wasm.closed).toBe(true);
  });

  it('builds the provider once, on the first connect that needs it', async () => {
    const provider = createChainCallbacks({ store: createLoopbackStore(), networks: [NETWORK] });

    // The People route must not drag the provider in at all.
    (await provider.connect(PEOPLE_GENESIS_HASH)).close();
    expect(wasm.built).toBe(0);

    const genesis = Uint8Array.from({ length: 32 }, () => 0xab);
    await provider.connect(genesis);
    await provider.connect(genesis);
    expect(wasm.built).toBe(1);
  });
});
