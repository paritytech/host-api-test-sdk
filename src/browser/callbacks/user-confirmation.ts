/**
 * The two review entry points, both answered from `state.userConfirmationBehavior`.
 *
 * `confirmUserAction` takes a verdict; `confirmPermission` takes the same
 * verdict plus how long it lasts, and the core asks through it for the reviews
 * whose consent it can keep — identity and account disclosures. One behavior
 * answers both, so a test sets a policy once and it holds whichever way the
 * core asks.
 */
import type { PermissionDecision, UserConfirmationReview } from '@parity/truapi-host';
import { decideConsent } from '../../types.js';
import type { HostState } from './state.js';

function decide(
  state: HostState,
  review: UserConfirmationReview,
  lifetimeAsked: boolean,
): PermissionDecision {
  const decision = decideConsent(state.userConfirmationBehavior, {
    tag: review.tag,
    value: review.value,
  });
  state.userConfirmationLog.push({
    tag: review.tag,
    approved: decision !== 'Deny',
    decision,
    lifetimeAsked,
    timestamp: Date.now(),
  });
  return decision;
}

export function createUserConfirmationCallbacks(state: HostState): {
  confirmUserAction(review: UserConfirmationReview): Promise<boolean>;
  confirmPermission(review: UserConfirmationReview): Promise<PermissionDecision>;
} {
  return {
    async confirmUserAction(review: UserConfirmationReview): Promise<boolean> {
      // The lifetime is not asked for here, so a one-use answer is logged as
      // what the core will read it as: an approval, good for this action only.
      return decide(state, review, false) !== 'Deny';
    },

    async confirmPermission(review: UserConfirmationReview): Promise<PermissionDecision> {
      return decide(state, review, true);
    },
  };
}
