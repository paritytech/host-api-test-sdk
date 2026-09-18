/** `confirmUserAction`: answered from `state.userConfirmationBehavior`, then logged. */
import type { UserConfirmationReview } from '@parity/truapi-host';
import type { HostState } from './state.js';

export function createUserConfirmationCallbacks(state: HostState): {
  confirmUserAction(review: UserConfirmationReview): Promise<boolean>;
} {
  return {
    async confirmUserAction(review: UserConfirmationReview): Promise<boolean> {
      const behavior = state.userConfirmationBehavior;
      const request = { tag: review.tag, value: review.value };
      const approved =
        behavior === 'approve-all'
          ? true
          : behavior === 'reject-all'
            ? false
            : behavior(request);

      state.userConfirmationLog.push({ tag: review.tag, approved, timestamp: Date.now() });
      return approved;
    },
  };
}
