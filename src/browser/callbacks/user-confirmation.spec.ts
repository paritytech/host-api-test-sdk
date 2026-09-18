import { describe, expect, it } from 'vitest';
import type { UserConfirmationReview } from '@parity/truapi-host';
import { createUserConfirmationCallbacks } from './user-confirmation.js';
import { createHostState } from './state.js';

// Every real variant's `value` is a specific payload object, which the
// callback never inspects; a bare tag is all these tests need.
const fakeReview = (tag: string): UserConfirmationReview =>
  ({ tag, value: undefined }) as unknown as UserConfirmationReview;
const review = fakeReview('SignRaw');

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
    expect(await confirmUserAction(fakeReview('CreateTransaction'))).toBe(true);
    expect(seen).toEqual(['SignRaw', 'CreateTransaction']);
  });
});
