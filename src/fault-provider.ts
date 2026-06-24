/**
 * Fault-injection transport wrapper.
 *
 * Wraps a `@novasamatech/host-api` `Provider` (the raw Uint8Array postMessage
 * channel between host and product) and applies SDK-level failure modes so they
 * are reproducible in CI instead of only against real hosts, by hand, after the
 * fact:
 *
 *   - `latencyMs`     — delay every message in both directions
 *   - `dropHandshake` — never deliver the handshake response → reproduces #200
 *                       (the SDK's `isReady()` hangs; a bounded-readiness SDK
 *                       should instead throw `HostNotReadyError`)
 *   - `dropEveryNth`  — drop every Nth inbound (product→host) message, to
 *                       exercise the signer retry path under a flaky transport
 *
 * This module is intentionally DOM-free and has no runtime imports (the two
 * `import type` lines are erased at compile time), so it lives outside
 * `src/browser/**` — that lets `tsc` emit `dist/fault-provider.js`, which is
 * both bundled into the browser runtime by esbuild AND unit-testable under
 * `node --test` without a browser. See `fault-provider.test.mjs`.
 */
import type { Provider } from '@novasamatech/host-api';
import type { FaultConfig } from './types.js';

/**
 * Enum index of `host_handshake_response` within the `MessagePayload` codec
 * (`host_handshake_request` is 0, `host_handshake_response` is 1). This is the
 * foundational handshake frame — wire id 1 in TrUAPI terms — and is the single
 * most stable discriminant in the protocol; changing it would break every host
 * and client simultaneously. We read it instead of importing the (non-root-
 * exported) `Message`/`MessagePayload` codecs from `@novasamatech/host-api`'s
 * internal subpath.
 */
export const HANDSHAKE_RESPONSE_INDEX = 1;

/**
 * Read a SCALE compact-encoded unsigned integer at `offset`.
 * Handles single-, two-, and four-byte modes — `requestId` strings are short,
 * so their length prefix never needs the big-integer mode (3).
 */
function readCompactUint(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } {
  const first = bytes[offset];
  const mode = first & 0b11;
  if (mode === 0) {
    return { value: first >> 2, nextOffset: offset + 1 };
  }
  if (mode === 1) {
    const value = (first | (bytes[offset + 1] << 8)) >> 2;
    return { value, nextOffset: offset + 2 };
  }
  if (mode === 2) {
    const value =
      (first |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        bytes[offset + 3] * 2 ** 24) >>>
      2;
    return { value, nextOffset: offset + 4 };
  }
  throw new Error('compact big-integer mode unsupported for requestId length');
}

/**
 * Is this outbound frame a `host_handshake_response`?
 *
 * The wire frame is `Struct({ requestId: str, payload: MessagePayload })`.
 * `str` is a SCALE compact length prefix followed by UTF-8 bytes; the payload
 * enum's index byte comes immediately after. We read that index and compare it
 * to {@link HANDSHAKE_RESPONSE_INDEX}. Any decode hiccup is treated as
 * "not a handshake" — fault injection must never corrupt a real frame.
 */
export function isHandshakeResponse(frame: Uint8Array): boolean {
  try {
    const { value: requestIdLen, nextOffset } = readCompactUint(frame, 0);
    const payloadIndex = frame[nextOffset + requestIdLen];
    return payloadIndex === HANDSHAKE_RESPONSE_INDEX;
  } catch {
    return false;
  }
}

/** Run `fn` now, or after `latencyMs` if a positive delay is configured. */
function deliver(fn: () => void, latencyMs?: number): void {
  if (latencyMs && latencyMs > 0) {
    setTimeout(fn, latencyMs);
  } else {
    fn();
  }
}

/**
 * Wrap a `Provider` with fault injection. `getFaults` is read on every message
 * so faults can be toggled at runtime (via `window.__TEST_HOST__.setFaults`)
 * as well as configured up front. With an empty/absent config this is a
 * transparent pass-through.
 */
export function createFaultProvider(
  inner: Provider,
  getFaults: () => FaultConfig | undefined,
): Provider {
  // Counts inbound (product→host) messages for `dropEveryNth`. Per wrapper
  // instance, so it resets when the container is recreated (account switch).
  let inboundCount = 0;

  return {
    logger: inner.logger,
    isCorrectEnvironment: () => inner.isCorrectEnvironment(),

    // Host → product.
    postMessage(message: Uint8Array): void {
      const faults = getFaults() ?? {};
      if (faults.dropHandshake && isHandshakeResponse(message)) {
        // Swallow the handshake response: the product never sees it, so its
        // readiness never resolves. This is the permanent CI repro for #200.
        return;
      }
      deliver(() => inner.postMessage(message), faults.latencyMs);
    },

    // Product → host.
    subscribe(callback: (message: Uint8Array) => void): () => void {
      return inner.subscribe((message: Uint8Array) => {
        const faults = getFaults() ?? {};
        inboundCount += 1;
        if (
          faults.dropEveryNth &&
          faults.dropEveryNth > 0 &&
          inboundCount % faults.dropEveryNth === 0
        ) {
          // Drop this inbound frame to exercise the SDK's retry path.
          return;
        }
        deliver(() => callback(message), faults.latencyMs);
      });
    },

    dispose: () => inner.dispose(),
  };
}
