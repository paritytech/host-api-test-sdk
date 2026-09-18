/**
 * Push-to-async-iterator bridge, plus the callback groups the core pulls as
 * `AsyncIterable`s. Everything feeding these is push-shaped while the core
 * pulls with `for await`, so `createPushChannel` buffers anything pushed before
 * the first pull and runs `onClose` exactly once — on an explicit close or on
 * the `return()` a `for await ... break` triggers.
 */
import { ok } from 'neverthrow';
import { type GenericError, type HostLocaleSubscribeItem, type HostThemeSubscribeItem, type Result, scale } from '@parity/truapi';
import type { HostState, Theme } from './state.js';

export interface PushChannel<T> {
  push(value: T): void;
  /** Ends the stream: anything already buffered is drained first, then iteration completes. */
  close(): void;
  readonly iterable: AsyncIterable<T>;
}

export function createPushChannel<T>(onClose?: () => void): PushChannel<T> {
  const buffered: T[] = [];
  const waiting: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  function push(value: T): void {
    if (closed) return;
    const resolve = waiting.shift();
    if (resolve) {
      resolve({ value, done: false });
    } else {
      buffered.push(value);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    while (waiting.length > 0) {
      waiting.shift()?.({ value: undefined as never, done: true });
    }
    onClose?.();
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift() as T, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => {
            waiting.push(resolve);
          });
        },
        return(): Promise<IteratorResult<T>> {
          close();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };

  return { push, close, iterable };
}

/** Every subscription is replayed the current theme before future `setTheme` pushes. */
export function createThemeCallbacks(state: HostState): {
  subscribeTheme(): AsyncIterable<Result<HostThemeSubscribeItem, GenericError>>;
} {
  return {
    subscribeTheme() {
      const notify = (theme: Theme) => channel.push(ok(theme));
      const channel = createPushChannel<Result<HostThemeSubscribeItem, GenericError>>(() => {
        state.themeSubscribers.delete(notify);
      });
      state.themeSubscribers.add(notify);
      notify(state.theme);
      return channel.iterable;
    },
  };
}

/** A single static default, in the same subscribe-then-replay shape as theme. */
export function createLocaleCallbacks(state: HostState): {
  subscribeLocale(): AsyncIterable<Result<HostLocaleSubscribeItem, GenericError>>;
} {
  return {
    subscribeLocale() {
      const notify = (locale: string) => channel.push(ok({ languageTag: locale }));
      const channel = createPushChannel<Result<HostLocaleSubscribeItem, GenericError>>(() => {
        state.localeSubscribers.delete(notify);
      });
      state.localeSubscribers.add(notify);
      notify(state.locale);
      return channel.iterable;
    },
  };
}

/** Emits the current value (`undefined` for a miss) first, then later writes to that key. */
export function createPreimageCallbacks(state: HostState): {
  lookupPreimage(key: Uint8Array): AsyncIterable<Result<Uint8Array | undefined, GenericError>>;
} {
  return {
    lookupPreimage(key: Uint8Array) {
      const keyHex = scale.bytesToHex(key);
      const notify = (value: Uint8Array | undefined) => channel.push(ok(value));
      const channel = createPushChannel<Result<Uint8Array | undefined, GenericError>>(() => {
        const subs = state.preimageSubscribers.get(keyHex);
        if (!subs) return;
        subs.delete(notify);
        if (subs.size === 0) state.preimageSubscribers.delete(keyHex);
      });

      let subs = state.preimageSubscribers.get(keyHex);
      if (!subs) {
        subs = new Set();
        state.preimageSubscribers.set(keyHex, subs);
      }
      subs.add(notify);

      notify(state.preimages.get(keyHex)?.value);
      return channel.iterable;
    },
  };
}
