import { describe, expect, it } from 'vitest';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import { createLoopbackStore } from '../loopback-chain.js';
import type { ChainRuntimeConfig, RpcConnection } from './chain.js';
import { createChainCallbacks, registerRpcChains } from './chain.js';

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

  /**
   * A stand-in for `@parity/truapi-provider`'s `Connection`: a raw string pipe
   * whose `nextResponse()` hands out queued frames and then `undefined`, the
   * way the real one does once the connection is closed or dead. No wasm, no
   * socket.
   */
  function fakeConnection(frames: string[]): RpcConnection & { sent: string[]; closed: boolean } {
    const queue = [...frames];
    return {
      sent: [],
      closed: false,
      send(request: string) {
        this.sent.push(request);
      },
      async nextResponse() {
        return queue.shift();
      },
      close() {
        this.closed = true;
      },
    };
  }

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
    const connection = fakeConnection(['{"id":1}', '{"id":2}']);
    const asked: string[] = [];
    const provider = createChainCallbacks({
      store: createLoopbackStore(),
      networks: [NETWORK],
      openRpcProvider: async () => ({
        connect: async (genesisHash) => {
          asked.push(genesisHash);
          return connection;
        },
      }),
    });

    const opened = await provider.connect(Uint8Array.from({ length: 32 }, () => 0xab));
    expect(asked).toEqual([`0x${'ab'.repeat(32)}`]);

    opened.send('{"id":1,"method":"chainSpec_v1_genesisHash"}');
    expect(connection.sent).toEqual(['{"id":1,"method":"chainSpec_v1_genesisHash"}']);

    // `responses()` is a pull loop over `nextResponse()`, and the queue above
    // runs dry — which is how the provider reports a closed or dead pipe.
    const received: string[] = [];
    for await (const frame of opened.responses()) received.push(frame);
    expect(received).toEqual(['{"id":1}', '{"id":2}']);

    opened.close();
    expect(connection.closed).toBe(true);
  });

  it('builds the provider once, on the first connect that needs it', async () => {
    let built = 0;
    const provider = createChainCallbacks({
      store: createLoopbackStore(),
      networks: [NETWORK],
      openRpcProvider: async () => {
        built += 1;
        return { connect: async () => fakeConnection([]) };
      },
    });

    // The People route must not drag the provider in at all.
    (await provider.connect(PEOPLE_GENESIS_HASH)).close();
    expect(built).toBe(0);

    const genesis = Uint8Array.from({ length: 32 }, () => 0xab);
    await provider.connect(genesis);
    await provider.connect(genesis);
    expect(built).toBe(1);
  });
});
