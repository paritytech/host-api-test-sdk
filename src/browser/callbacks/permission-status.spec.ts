import { describe, expect, it } from 'vitest';
import { createPermissionStatusCallbacks } from './permission-status.js';
import { createHostState } from './state.js';

describe('permission status callbacks', () => {
  it('reports the default until a test sets one', async () => {
    const state = createHostState();
    const { devicePermissionStatus } = createPermissionStatusCallbacks(state);
    // HostDevicePermissionRequest is a bare string union, not an object.
    const request = 'Camera' as const;

    const before = await devicePermissionStatus(request);
    state.devicePermissionStatuses.set('Camera', 'Denied');
    const after = await devicePermissionStatus(request);

    expect(before).toBe('Granted');
    expect(after).not.toEqual(before);
    expect(after).toBe('Denied');
  });
});
