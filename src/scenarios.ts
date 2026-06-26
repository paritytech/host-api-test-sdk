import type { FaultConfig } from './types.js';

/**
 * Canned fault scenarios for common SDK-resilience tests. Pass one as the
 * `faults` option to `createTestHostServer` / `createTestHostFixture`, or feed
 * it to `testHost.setFaults(...)` at runtime.
 *
 * ```ts
 * import { FAULT_SCENARIOS } from '@parity/host-api-test-sdk';
 *
 * const host = await createTestHostServer({
 *   productUrl,
 *   faults: FAULT_SCENARIOS.droppedHandshake, // SDK must throw, not hang
 * });
 * ```
 */
export const FAULT_SCENARIOS = {
  /**
   * Host never answers the handshake. The permanent CI repro for #200 — a
   * bounded-readiness SDK must surface `HostNotReadyError` rather than hang on
   * `isReady()`.
   */
  droppedHandshake: { dropHandshake: true },

  /**
   * Drop every inbound message. On this engine a dropped request has no retry
   * path, so the affected call stalls — assert the SDK does not silently
   * succeed (a true "retry recovers" test needs a bounded request + a
   * retry-capable signer; not available on the `@novasamatech` engine).
   */
  flakyTransport: { dropEveryNth: 1 },

  /**
   * Version-skewed host: the handshake claims an unsupported codec id, so the
   * host answers with `UnsupportedProtocolVersion` and the client detects skew
   * at handshake instead of hanging.
   */
  versionSkew: { protocolVersion: 2 },

  /**
   * 130s of latency on every message. Validates that interactive-category
   * timeouts (signing/permissions/payments) tolerate manual-approval delay.
   */
  slowSigning: { latencyMs: 130_000 },

  /** A milder 2s latency for general soak/churn use. */
  highLatency: { latencyMs: 2_000 },
} as const satisfies Record<string, FaultConfig>;
