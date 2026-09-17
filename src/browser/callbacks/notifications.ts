/**
 * Notifications: records what the product asked to push instead of
 * displaying anything.
 *
 * Ported from `host-runtime.ts`'s `handlePushNotification` /
 * `handlePushNotificationCancel` — same id assignment and logging. One
 * deliberate deviation: the upstream `cancelNotification` contract is
 * documented as idempotent ("cancelling an already-fired or unknown id
 * still returns success"), unlike the pre-migration handler, which errored
 * on an unknown id. This follows the new contract rather than the old
 * behavior.
 */
import type { HostPushNotificationRequest, HostPushNotificationResponse, NotificationId } from '@parity/truapi';
import type { HostState } from './state.js';

export function createNotificationCallbacks(state: HostState): {
  pushNotification(notification: HostPushNotificationRequest): Promise<HostPushNotificationResponse>;
  cancelNotification(id: NotificationId): Promise<void>;
} {
  let nextId = 1;

  return {
    async pushNotification(notification: HostPushNotificationRequest): Promise<HostPushNotificationResponse> {
      const id = nextId++;
      state.notificationLog.push({
        id,
        text: notification.text,
        deeplink: notification.deeplink,
        scheduledAt: notification.scheduledAt,
        cancelled: false,
        timestamp: Date.now(),
      });
      console.log(
        '[test-host] Notification:',
        `#${id}`,
        notification.text,
        notification.deeplink ? `(deeplink: ${notification.deeplink})` : '',
        notification.scheduledAt !== undefined ? `(scheduledAt: ${notification.scheduledAt})` : '',
      );
      return { id };
    },

    async cancelNotification(id: NotificationId): Promise<void> {
      const entry = state.notificationLog.find((e) => e.id === id);
      if (entry) entry.cancelled = true;
      // Idempotent: an unknown or already-fired id still succeeds.
    },
  };
}
