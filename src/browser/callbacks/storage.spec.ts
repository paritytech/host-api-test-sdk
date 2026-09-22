import { describe, expect, it } from 'vitest';
import type { GenericError, HostLocalStorageChangeItem, Result } from '@parity/truapi';
import {
  clearAllProductStorage,
  createProductStorageCallbacks,
  setProductStorage,
} from './storage.js';
import { createHostState } from './state.js';

const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * Pulls the stream into an array as items arrive. The core consumes it with
 * `for await`, and so does this, so a change pushed before the next `next()`
 * still has to land.
 */
function collect(
  stream: AsyncIterable<Result<HostLocalStorageChangeItem, GenericError>>,
): { items: Array<HostLocalStorageChangeItem['value']>; stop(): Promise<void> } {
  const items: Array<HostLocalStorageChangeItem['value']> = [];
  const iterator = stream[Symbol.asyncIterator]();
  const pump = async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      items.push(next.value._unsafeUnwrap().value);
    }
  };
  void pump();
  return {
    items,
    async stop() {
      await iterator.return?.();
    },
  };
}

/** One microtask turn, so the pump above has picked up whatever was pushed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('product storage callbacks', () => {
  it('serves what a test seeded before the product asks', async () => {
    const state = createHostState();
    state.productStorage.set('token', bytes('seeded'));
    const { read } = createProductStorageCallbacks(state);
    expect(await read('token')).toEqual(bytes('seeded'));
  });

  it('exposes what the product wrote, and honours clear', async () => {
    const state = createHostState();
    const { read, write, clear } = createProductStorageCallbacks(state);

    await write('k', bytes('v'));
    expect(state.productStorage.get('k')).toEqual(bytes('v'));
    expect(await read('k')).toEqual(bytes('v'));

    await clear('k');
    expect(state.productStorage.has('k')).toBe(false);
    expect(await read('k')).toBeUndefined();
  });
});

describe('product storage subscriptions', () => {
  it('replays the current value, hex-encoded, before any change', async () => {
    const state = createHostState();
    state.productStorage.set('token', bytes('seeded'));
    const { subscribeStorage } = createProductStorageCallbacks(state);

    const stream = collect(subscribeStorage('token'));
    await settle();

    expect(stream.items).toEqual([`0x${Buffer.from('seeded').toString('hex')}`]);
    await stream.stop();
  });

  it('opens on a miss with no value, then reports the first write', async () => {
    const state = createHostState();
    const { subscribeStorage, write } = createProductStorageCallbacks(state);

    const stream = collect(subscribeStorage('k'));
    await settle();
    await write('k', bytes('v'));
    await settle();

    expect(stream.items).toEqual([undefined, '0x76']);
    await stream.stop();
  });

  it('reports a clear as an absent value', async () => {
    const state = createHostState();
    const { subscribeStorage, write, clear } = createProductStorageCallbacks(state);

    const stream = collect(subscribeStorage('k'));
    await settle();
    await write('k', bytes('v'));
    await clear('k');
    await settle();

    expect(stream.items).toEqual([undefined, '0x76', undefined]);
    await stream.stop();
  });

  it('reports what a test seeded, not only what the product wrote', async () => {
    const state = createHostState();
    const { subscribeStorage } = createProductStorageCallbacks(state);

    const stream = collect(subscribeStorage('k'));
    await settle();
    setProductStorage(state, 'k', bytes('v'));
    clearAllProductStorage(state);
    await settle();

    expect(stream.items).toEqual([undefined, '0x76', undefined]);
    await stream.stop();
  });

  it('leaves other keys alone', async () => {
    const state = createHostState();
    const { subscribeStorage, write } = createProductStorageCallbacks(state);

    const stream = collect(subscribeStorage('k'));
    await settle();
    await write('other', bytes('v'));
    await settle();

    expect(stream.items).toEqual([undefined]);
    await stream.stop();
  });

  it('drops the listener when the consumer stops pulling', async () => {
    const state = createHostState();
    const { subscribeStorage } = createProductStorageCallbacks(state);

    const stream = collect(subscribeStorage('k'));
    await settle();
    expect(state.productStorageSubscribers.get('k')?.size).toBe(1);

    await stream.stop();
    expect(state.productStorageSubscribers.has('k')).toBe(false);
  });
});
