/** Notifications: records what the product asked to push instead of displaying it. */
import type { HostPushNotificationRequest, HostPushNotificationResponse, NotificationId } from '@parity/truapi';
import { decideBehavior } from '../../types.js';
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

      // `Notifications.pushNotification` declares no error response, so refusal is a thrown
      // error; the id is still allocated so ids never collide across refusals.
      const { text, deeplink, scheduledAt } = notification;
      if (!decideBehavior(state.notificationBehavior, { text, deeplink, scheduledAt })) {
        throw new Error('Notification refused by the test host');
      }

      return { id };
    },

    async cancelNotification(id: NotificationId): Promise<void> {
      const entry = state.notificationLog.find((e) => e.id === id);
      if (entry) entry.cancelled = true;
      // Idempotent: an unknown or already-fired id still succeeds.
    },
  };
}
