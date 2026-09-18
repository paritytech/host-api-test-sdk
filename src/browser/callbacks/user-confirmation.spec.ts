import { describe, expect, it } from 'vitest';
import type { UserConfirmationReview } from '@parity/truapi-host';
import { createUserConfirmationCallbacks } from './user-confirmation.js';
import { createHostState } from './state.js';

const account = { dotNsIdentifier: 'test-product.dot', derivationIndex: { tag: 'Index', value: 0 } } as const;

// The callback only reads `.tag`/`.value` generically, but a real review's
// shape still has to satisfy `UserConfirmationReview` — no cast.
const review: UserConfirmationReview = {
  tag: 'SignRaw',
  value: {
    tag: 'Product',
    value: {
      request: { account, payload: { tag: 'Bytes', value: { bytes: '0x00' } } },
      watermarked: false,
    },
  },
};

const statementReview: UserConfirmationReview = {
  tag: 'StatementStoreProductSign',
  value: { account, payload: new Uint8Array() },
};

describe('user confirmation callbacks', () => {
  it('approves by default and logs the review', async () => {
    const state = createHostState();
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(true);
    expect(state.userConfirmationLog).toEqual([
      { tag: 'SignRaw', approved: true, timestamp: expect.any(Number) },
    ]);
  });

  it('rejects every review under reject-all', async () => {
    const state = createHostState();
    state.userConfirmationBehavior = 'reject-all';
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(false);
    expect(state.userConfirmationLog[0].approved).toBe(false);
  });

  it('asks the function form, which sees the review', async () => {
    const state = createHostState();
    const seen: string[] = [];
    state.userConfirmationBehavior = (request) => {
      seen.push(request.tag);
      return request.tag !== 'SignRaw';
    };
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(false);
    expect(await confirmUserAction(statementReview)).toBe(true);
    expect(seen).toEqual(['SignRaw', 'StatementStoreProductSign']);
  });
});
