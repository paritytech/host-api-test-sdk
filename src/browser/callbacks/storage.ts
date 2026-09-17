/**
 * Product and core storage: both in-memory `Map`s, never persisted.
 *
 * `productStorage` keys arrive already namespaced by the core, so they are
 * used as-is — no extra scoping is added here (unlike pre-migration's
 * `handleLocalStorageRead/Write/Clear`, which prefixed `localStorage` keys
 * with `test-host:` itself; that scoping is now the core's job).
 *
 * `coreStorage` keys are typed `CoreStorageKey` variants, encoded via
 * `encodeCoreStorageKey` (exported by `@parity/truapi-host`) into a stable
 * string so they can key a `Map`. Every run starts from a clean session —
 * this is a fresh `Map` per `createHostCallbacks()` call, with no backing
 * store to load from or persist to.
 */
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorageKey } from '@parity/truapi-host';

export function createProductStorageCallbacks(): {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  clear(key: string): Promise<void>;
} {
  const store = new Map<string, Uint8Array>();
  return {
    async read(key: string): Promise<Uint8Array | undefined> {
      return store.get(key);
    },
    async write(key: string, value: Uint8Array): Promise<void> {
      store.set(key, value);
    },
    async clear(key: string): Promise<void> {
      store.delete(key);
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
