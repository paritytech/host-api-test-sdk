import { describe, expect, it } from 'vitest';
import { createNotificationCallbacks } from './notifications.js';
import { createHostState } from './state.js';

const request = { text: 'hello' } as const;

describe('notification callbacks', () => {
  it('returns an incrementing id and logs by default', async () => {
    const state = createHostState();
    const { pushNotification } = createNotificationCallbacks(state);
    expect((await pushNotification(request)).id).toBe(1);
    expect((await pushNotification(request)).id).toBe(2);
    expect(state.notificationLog).toHaveLength(2);
  });

  it('hands the function form every field the request carried', async () => {
    const state = createHostState();
    const seen: unknown[] = [];
    state.notificationBehavior = (notification) => {
      seen.push(notification);
      // A test that refuses only scheduled notifications is the point of the wider request.
      return notification.scheduledAt === undefined;
    };
    const { pushNotification } = createNotificationCallbacks(state);

    await expect(
      pushNotification({ text: 'later', deeplink: 'polkadot://a.dot', scheduledAt: 42n }),
    ).rejects.toThrow(/refused/i);
    expect(seen).toEqual([{ text: 'later', deeplink: 'polkadot://a.dot', scheduledAt: 42n }]);

    expect((await pushNotification({ text: 'now' })).id).toBe(2);
  });

  it('refuses under reject-all and still logs the attempt', async () => {
    const state = createHostState();
    state.notificationBehavior = 'reject-all';
    const { pushNotification } = createNotificationCallbacks(state);
    await expect(pushNotification(request)).rejects.toThrow(/refused/i);
    expect(state.notificationLog).toHaveLength(1);
  });
});
