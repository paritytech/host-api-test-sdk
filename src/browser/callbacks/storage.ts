/**
 * Product and core storage: both in-memory `Map`s, never persisted, so every
 * run starts clean. `productStorage` keys arrive already namespaced by the
 * core, so no scoping is added here.
 *
 * Every product-storage mutation goes through `setProductStorage` /
 * `clearProductStorage` rather than touching the `Map`, because
 * `subscribeStorage` has to see a test's seed and a product's write alike.
 */
import { ok } from 'neverthrow';
import { type GenericError, type HostLocalStorageChangeItem, type Result, scale } from '@parity/truapi';
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorageKey } from '@parity/truapi-host';
import { createPushChannel } from './passive.js';
import type { HostState } from './state.js';

/**
 * The core namespaces every product-storage key before handing it to the host,
 * as `truapi:product-storage:v1:<productIdLength>:<productId>:<localKey>`. The
 * length prefix is what makes this unambiguous: a product id or a local key may
 * itself contain `:`, so splitting on the separator would guess wrong, while
 * counting `productIdLength` characters cannot.
 *
 * Returns `undefined` for anything that does not parse, rather than guessing —
 * if the core ever moves to a `v2` layout, a test reading `localKey` sees it go
 * missing instead of silently matching the wrong entry.
 */
const NAMESPACE_PREFIX = 'truapi:product-storage:v1:';

export function parseProductStorageKey(
  key: string,
): { productId: string; localKey: string } | undefined {
  if (!key.startsWith(NAMESPACE_PREFIX)) return undefined;
  const rest = key.slice(NAMESPACE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return undefined;
  const digits = rest.slice(0, separator);
  if (!/^\d+$/.test(digits)) return undefined;

  const length = Number(digits);
  const productId = rest.slice(separator + 1, separator + 1 + length);
  if (productId.length !== length) return undefined;
  // The character right after the id must be the separator before the local
  // key; anything else means the length did not describe this key.
  if (rest[separator + 1 + length] !== ':') return undefined;

  return { productId, localKey: rest.slice(separator + 2 + length) };
}

function notify(state: HostState, key: string, value: Uint8Array | undefined): void {
  for (const listener of state.productStorageSubscribers.get(key) ?? []) listener(value);
}

/** Write one product-storage entry and push it to that key's subscribers. */
export function setProductStorage(state: HostState, key: string, value: Uint8Array): void {
  state.productStorage.set(key, value);
  notify(state, key, value);
}

/** Drop one product-storage entry and push the clear to that key's subscribers. */
export function clearProductStorage(state: HostState, key: string): void {
  state.productStorage.delete(key);
  notify(state, key, undefined);
}

/**
 * Drop every entry. Only the keys that held a value are pushed a clear: a
 * subscriber on a key that was already empty has nothing new to hear.
 */
export function clearAllProductStorage(state: HostState): void {
  const keys = [...state.productStorage.keys()];
  state.productStorage.clear();
  for (const key of keys) notify(state, key, undefined);
}

export function createProductStorageCallbacks(state: HostState): {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  clear(key: string): Promise<void>;
  subscribeStorage(key: string): AsyncIterable<Result<HostLocalStorageChangeItem, GenericError>>;
} {
  return {
    async read(key: string): Promise<Uint8Array | undefined> {
      return state.productStorage.get(key);
    },
    async write(key: string, value: Uint8Array): Promise<void> {
      setProductStorage(state, key, value);
    },
    async clear(key: string): Promise<void> {
      clearProductStorage(state, key);
    },
    /**
     * Emits the current value (`undefined` for a miss) first, then every later
     * change to that key — the same subscribe-then-replay shape as
     * `lookupPreimage`. Repeats are not filtered here; the core drops an item
     * that repeats the value it last delivered.
     */
    subscribeStorage(key: string) {
      const listener = (value: Uint8Array | undefined) =>
        channel.push(ok({ value: value === undefined ? undefined : scale.bytesToHex(value) }));
      const channel = createPushChannel<Result<HostLocalStorageChangeItem, GenericError>>(() => {
        const subs = state.productStorageSubscribers.get(key);
        if (!subs) return;
        subs.delete(listener);
        if (subs.size === 0) state.productStorageSubscribers.delete(key);
      });

      let subs = state.productStorageSubscribers.get(key);
      if (!subs) {
        subs = new Set();
        state.productStorageSubscribers.set(key, subs);
      }
      subs.add(listener);

      listener(state.productStorage.get(key));
      return channel.iterable;
    },
  };
}

export function createCoreStorageCallbacks(): {
  readCoreStorage(key: CoreStorageKey): Promise<Uint8Array | undefined>;
  writeCoreStorage(key: CoreStorageKey, value: Uint8Array): Promise<void>;
  clearCoreStorage(key: CoreStorageKey): Promise<void>;
} {
  const store = new Map<string, Uint8Array>();
  const keyOf = (key: CoreStorageKey): string => encodeCoreStorageKey(key).join(',');

  return {
    async readCoreStorage(key: CoreStorageKey): Promise<Uint8Array | undefined> {
      return store.get(keyOf(key));
    },
    async writeCoreStorage(key: CoreStorageKey, value: Uint8Array): Promise<void> {
      store.set(keyOf(key), value);
    },
    async clearCoreStorage(key: CoreStorageKey): Promise<void> {
      store.delete(keyOf(key));
    },
  };
}
