import { describe, expect, it } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createOperationCallbacks } from './operations.js';
import { createHostState } from './state.js';

const product: ProductContext = { productId: 'test-product.dot', executionKind: 'Worker' };
const other: ProductContext = { productId: 'other.dot', executionKind: 'Worker' };

describe('product operation callbacks', () => {
  it('records an operation and reports it open', async () => {
    const state = createHostState();
    const { beginOperation } = createOperationCallbacks(state);

    const { id } = await beginOperation(product, 'sync');

    expect(state.openOperations.get(id)).toMatchObject({
      id,
      productId: 'test-product.dot',
      label: 'sync',
      endedAt: undefined,
    });
    expect(state.operationLog).toHaveLength(1);
  });

  it('keeps the ended operation in the log, out of the open set', async () => {
    const state = createHostState();
    const { beginOperation, endOperation } = createOperationCallbacks(state);

    const { id } = await beginOperation(product, 'sync');
    await endOperation(product, id);

    expect(state.openOperations.size).toBe(0);
    expect(state.operationLog).toHaveLength(1);
    expect(state.operationLog[0].endedAt).toEqual(expect.any(Number));
  });

  it('hands out ids no two open operations share', async () => {
    const state = createHostState();
    const { beginOperation } = createOperationCallbacks(state);

    const ids = [
      (await beginOperation(product, 'a')).id,
      (await beginOperation(product, 'b')).id,
      (await beginOperation(other, 'c')).id,
    ];

    expect(new Set(ids).size).toBe(3);
  });

  // The core retries an end after an ambiguous failure, so neither a repeat nor
  // an id that was never opened may throw.
  it('ends idempotently', async () => {
    const state = createHostState();
    const { beginOperation, endOperation } = createOperationCallbacks(state);

    const { id } = await beginOperation(product, '');
    await endOperation(product, id);
    await expect(endOperation(product, id)).resolves.toBeUndefined();
    await expect(endOperation(product, 9999)).resolves.toBeUndefined();

    expect(state.operationLog).toHaveLength(1);
  });
});
