import type { HexString } from '@parity/truapi';
import type { ChainProvider, JsonRpcConnection } from '@parity/truapi-host';
import { scale } from '@parity/truapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPushChannel } from './callbacks/passive.js';
import { METADATA_TIMEOUT_MS, createMetadataReader } from './chain-metadata.js';
import { syntheticMetadata } from './signing/general.fixture.js';

const GENESIS = `0x${'ab'.repeat(32)}` as HexString;
const METADATA = syntheticMetadata();
const SOME_METADATA = scale.bytesToHex(
  Uint8Array.from([0x01, ...scale.compact.enc(METADATA.length), ...METADATA]),
);

type Answer = { result: unknown } | { error: unknown } | 'silent';

/**
 * A chain that answers each JSON-RPC method with `answer`, and records the
 * connections it opened, what was sent on them, and whether they were closed.
 */
function fakeChain(answer: (method: string) => Answer, opts: { connectDelayMs?: number } = {}) {
  const connections: Array<{ sent: string[]; closed: boolean }> = [];
  const chain: ChainProvider = {
    async connect(): Promise<JsonRpcConnection> {
      if (opts.connectDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.connectDelayMs));
      const record = { sent: [] as string[], closed: false };
      connections.push(record);
      const channel = createPushChannel<string>();
      return {
        send(request: string) {
          const { id, method } = JSON.parse(request) as { id: number; method: string };
          record.sent.push(method);
          const reply = answer(method);
          if (reply !== 'silent') channel.push(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
        },
        responses: () => channel.iterable,
        close() {
          record.closed = true;
          channel.close();
        },
      };
    },
  };
  return { chain, connections };
}

const methodNotFound = { error: { code: -32601, message: 'Method not found' } };

describe('metadata reader', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads V16 metadata and closes the connection', async () => {
    const { chain, connections } = fakeChain((method) =>
      method === 'state_call' ? { result: SOME_METADATA } : methodNotFound,
    );

    const metadata = await createMetadataReader(chain)(GENESIS);

    expect([...metadata.pipelines.keys()]).toEqual([0, 1]);
    expect(connections).toEqual([{ sent: ['state_call'], closed: true }]);
  });

  it('falls back to state_getMetadata when the runtime has no V16', async () => {
    const { chain, connections } = fakeChain((method) =>
      method === 'state_call' ? { result: '0x00' } : { result: scale.bytesToHex(METADATA) },
    );

    await createMetadataReader(chain)(GENESIS);

    expect(connections[0]!.sent).toEqual(['state_call', 'state_getMetadata']);
  });

  it('falls back to state_getMetadata when the runtime refuses the V16 call', async () => {
    const { chain, connections } = fakeChain((method) =>
      method === 'state_call' ? methodNotFound : { result: scale.bytesToHex(METADATA) },
    );

    await createMetadataReader(chain)(GENESIS);

    expect(connections[0]!.sent).toEqual(['state_call', 'state_getMetadata']);
  });

  it('reports both refusals when neither read answers', async () => {
    const { chain } = fakeChain(() => methodNotFound);

    await expect(createMetadataReader(chain)(GENESIS)).rejects.toThrow(
      'cannot load chain metadata: state_call failed: {"code":-32601,"message":"Method not found"}; ' +
        'state_getMetadata failed: {"code":-32601,"message":"Method not found"}',
    );
  });

  it('reads once per genesis, however it is spelled', async () => {
    const { chain, connections } = fakeChain(() => ({ result: SOME_METADATA }));
    const read = createMetadataReader(chain);

    await Promise.all([read(GENESIS), read(` ${GENESIS.toUpperCase().replace('0X', '0x')} ` as HexString)]);

    expect(connections).toHaveLength(1);
  });

  it('forgets a failed read, so the next transaction tries again', async () => {
    let fail = true;
    const { chain, connections } = fakeChain(() => (fail ? methodNotFound : { result: SOME_METADATA }));
    const read = createMetadataReader(chain);

    await expect(read(GENESIS)).rejects.toThrow('cannot load chain metadata');
    fail = false;
    await read(GENESIS);

    expect(connections).toHaveLength(2);
  });

  it('gives up after the timeout and closes the connection', async () => {
    vi.useFakeTimers();
    const { chain, connections } = fakeChain(() => 'silent');

    const reading = createMetadataReader(chain)(GENESIS);
    const failed = expect(reading).rejects.toThrow(
      `cannot load chain metadata: no answer within ${METADATA_TIMEOUT_MS / 1000} s`,
    );
    await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS);
    await failed;

    expect(connections).toEqual([{ sent: ['state_call'], closed: true }]);
  });

  it('closes a connection that opens after the timeout and sends nothing on it', async () => {
    vi.useFakeTimers();
    const { chain, connections } = fakeChain(() => ({ result: SOME_METADATA }), {
      connectDelayMs: METADATA_TIMEOUT_MS + 1_000,
    });

    const reading = createMetadataReader(chain)(GENESIS);
    const failed = expect(reading).rejects.toThrow('no answer within');
    await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS + 1_000);
    await failed;

    expect(connections).toEqual([{ sent: [], closed: true }]);
  });
});
