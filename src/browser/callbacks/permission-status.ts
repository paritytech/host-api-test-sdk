/**
 * `permissionStatus`: reports the current OS status of a device permission
 * without prompting — distinct from `permissions.devicePermission`, which asks.
 */
import type { HostDevicePermissionRequest } from '@parity/truapi';
import type { DevicePermissionStatus } from '@parity/truapi-host';
import type { HostState } from './state.js';

// Must agree with `permissions.ts`'s default: `permissionBehavior` grants by
// default, so a status of anything else would contradict what the host answers.
const DEFAULT_STATUS: DevicePermissionStatus = 'Granted';

export function createPermissionStatusCallbacks(state: HostState): {
  devicePermissionStatus(request: HostDevicePermissionRequest): Promise<DevicePermissionStatus>;
} {
  return {
    async devicePermissionStatus(
      request: HostDevicePermissionRequest,
    ): Promise<DevicePermissionStatus> {
      return state.devicePermissionStatuses.get(request) ?? DEFAULT_STATUS;
    },
  };
}
