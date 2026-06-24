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
   * Drop every 3rd inbound message. Exercises the signer retry path
   * (`signer/src/retry.ts`) — it should recover within its retry budget.
   */
  flakyTransport: { dropEveryNth: 3 },

  /**
   * 130s of latency on every message. Validates that interactive-category
   * timeouts (signing/permissions/payments) tolerate manual-approval delay.
   */
  slowSigning: { latencyMs: 130_000 },

  /** A milder 2s latency for general soak/churn use. */
  highLatency: { latencyMs: 2_000 },
} as const satisfies Record<string, FaultConfig>;
