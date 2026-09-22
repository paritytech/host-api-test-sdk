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
      {
        tag: 'SignRaw',
        approved: true,
        decision: 'AllowAlways',
        lifetimeAsked: false,
        timestamp: expect.any(Number),
      },
    ]);
  });

  it('rejects every review under reject-all', async () => {
    const state = createHostState();
    state.userConfirmationBehavior = 'reject-all';
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(false);
    expect(state.userConfirmationLog[0].approved).toBe(false);
  });

  it('answers confirmPermission with a lifetime, off the same behavior', async () => {
    const state = createHostState();
    const { confirmPermission } = createUserConfirmationCallbacks(state);

    expect(await confirmPermission(review)).toBe('AllowAlways');

    state.userConfirmationBehavior = 'approve-once';
    expect(await confirmPermission(statementReview)).toBe('AllowOnce');

    state.userConfirmationBehavior = 'reject-all';
    expect(await confirmPermission(review)).toBe('Deny');

    expect(state.userConfirmationLog.map((e) => [e.decision, e.approved, e.lifetimeAsked])).toEqual([
      ['AllowAlways', true, true],
      ['AllowOnce', true, true],
      ['Deny', false, true],
    ]);
  });

  // `confirmUserAction` has nowhere to put a lifetime, so a one-use answer can
  // only reach the core as a plain approval. The log still records which it was.
  it('flattens a one-use answer to true on confirmUserAction', async () => {
    const state = createHostState();
    state.userConfirmationBehavior = 'approve-once';
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(true);
    expect(state.userConfirmationLog[0]).toMatchObject({
      decision: 'AllowOnce',
      approved: true,
      lifetimeAsked: false,
    });
  });

  it('takes a decision straight from the function form', async () => {
    const state = createHostState();
    state.userConfirmationBehavior = (request) =>
      request.tag === 'SignRaw' ? 'AllowOnce' : 'Deny';
    const { confirmPermission } = createUserConfirmationCallbacks(state);

    expect(await confirmPermission(review)).toBe('AllowOnce');
    expect(await confirmPermission(statementReview)).toBe('Deny');
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
