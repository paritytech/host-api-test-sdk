/** `confirmUserAction`: answered from `state.userConfirmationBehavior`, then logged. */
import type { UserConfirmationReview } from '@parity/truapi-host';
import { decideBehavior } from '../../types.js';
import type { HostState } from './state.js';

export function createUserConfirmationCallbacks(state: HostState): {
  confirmUserAction(review: UserConfirmationReview): Promise<boolean>;
} {
  return {
    async confirmUserAction(review: UserConfirmationReview): Promise<boolean> {
      const approved = decideBehavior(state.userConfirmationBehavior, {
        tag: review.tag,
        value: review.value,
      });
      state.userConfirmationLog.push({ tag: review.tag, approved, timestamp: Date.now() });
      return approved;
    },
  };
}
