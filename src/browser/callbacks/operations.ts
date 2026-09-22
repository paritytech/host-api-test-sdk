/**
 * `productOperations`: the store a `Worker` product's pending operations live
 * in. The core holds its worker runtime up for as long as one is open, so this
 * host records them rather than acting on them — a test reads `getOpenOperations()`
 * to see what is keeping the runtime alive, and what the product forgot to end.
 *
 * Nothing here refuses: `TooManyOpen` is a real host's back-pressure, and a test
 * host that imposed a limit would fail products for reasons no production host
 * would reproduce.
 */
import type { HostWorkerBeginOperationResponse } from '@parity/truapi';
import type { ProductContext } from '@parity/truapi-host';
import type { HostState } from './state.js';

export function createOperationCallbacks(state: HostState): {
  beginOperation(product: ProductContext, label: string): Promise<HostWorkerBeginOperationResponse>;
  endOperation(product: ProductContext, id: number): Promise<void>;
} {
  return {
    async beginOperation(
      product: ProductContext,
      label: string,
    ): Promise<HostWorkerBeginOperationResponse> {
      const id = state.nextOperationId++;
      const entry = {
        id,
        productId: product.productId,
        label,
        startedAt: Date.now(),
        endedAt: undefined as number | undefined,
      };
      // One object in both, so ending an operation marks it in the log too.
      state.openOperations.set(id, entry);
      state.operationLog.push(entry);
      return { id };
    },

    /**
     * Idempotent, as the core requires: an unknown or already-ended id is a
     * no-op. The product is not consulted because ids run off one counter for
     * the whole host — the protocol only asks that they be unique per product,
     * and globally unique satisfies that with no per-product bookkeeping.
     */
    async endOperation(_product: ProductContext, id: number): Promise<void> {
      const entry = state.openOperations.get(id);
      if (!entry) return;
      entry.endedAt = Date.now();
      state.openOperations.delete(id);
    },
  };
}
