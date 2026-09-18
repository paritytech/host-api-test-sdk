import { describe, expect, it } from 'vitest';
import { createProductStorageCallbacks } from './storage.js';
import { createHostState } from './state.js';

const bytes = (s: string) => new TextEncoder().encode(s);

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
