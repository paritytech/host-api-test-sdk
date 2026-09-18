/**
 * Product and core storage: both in-memory `Map`s, never persisted, so every
 * run starts clean. `productStorage` keys arrive already namespaced by the
 * core, so no scoping is added here.
 */
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorageKey } from '@parity/truapi-host';
import type { HostState } from './state.js';

export function createProductStorageCallbacks(state: HostState): {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  clear(key: string): Promise<void>;
} {
  return {
    async read(key: string): Promise<Uint8Array | undefined> {
      return state.productStorage.get(key);
    },
    async write(key: string, value: Uint8Array): Promise<void> {
      state.productStorage.set(key, value);
    },
    async clear(key: string): Promise<void> {
      state.productStorage.delete(key);
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
