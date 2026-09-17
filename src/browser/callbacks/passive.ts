/**
 * Push-to-async-iterator bridge, plus the three callback groups the core
 * pulls as `AsyncIterable`s: theme, locale, and preimage lookup.
 *
 * All three — and the chain connection's `responses()` in `chain.ts` — are
 * fed by ordinary pushes (a `Set` of subscriber callbacks, a per-key waiter
 * map, a loopback store's `onResponse` callback), but the core pulls them
 * via `for await`. `createPushChannel` is the one bridge shared by all four:
 * `push` feeds it from the producer side, and the `AsyncIterable` it returns
 * hands items to whichever consumer pulls — buffering anything pushed
 * before the first pull so nothing pushed early is dropped, and running
 * `onClose` (unsubscribing from whatever is feeding it) exactly once,
 * whether the stream is closed explicitly or the consumer stops pulling
 * (`for await...break` calls the iterator's `return()`).
 */
import { ok } from 'neverthrow';
import type { GenericError, HostLocaleSubscribeItem, HostThemeSubscribeItem, Result } from '@parity/truapi';
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

const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * Host theme source. Ported from `host-runtime.ts`'s `handleThemeSubscribe` /
 * `themeSubscribers`: every subscription is sent the current theme
 * immediately, then future `setTheme` calls (the control API pushes onto
 * `state.themeSubscribers` directly, matching the pre-migration pattern).
 */
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

/**
 * Host locale source. No pre-migration analogue — a single static default
 * emitted once, following the same subscribe-then-replay shape as theme so
 * a later control-plane addition can drive it the same way.
 */
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

/**
 * Host preimage backend. Ported from `host-runtime.ts`'s
 * `handlePreimageLookupSubscribe`: emits the current value (or `undefined`
 * for a miss) immediately, then whatever `seedPreimage` / a product's
 * `preimageSubmit` deliver for that exact key later.
 */
export function createPreimageCallbacks(state: HostState): {
  lookupPreimage(key: Uint8Array): AsyncIterable<Result<Uint8Array | undefined, GenericError>>;
} {
  return {
    lookupPreimage(key: Uint8Array) {
      const keyHex = toHex(key).toLowerCase();
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
