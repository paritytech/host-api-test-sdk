import { describe, expect, it } from 'vitest';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import { createLoopbackStore } from '../loopback-chain.js';
import { createChainCallbacks } from './chain.js';

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
