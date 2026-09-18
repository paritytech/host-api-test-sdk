/** Permissions: device and remote prompts, answered from `state.permissionBehavior`. */
import type {
  HostDevicePermissionRequest,
  HostDevicePermissionResponse,
  RemotePermissionRequest,
  RemotePermissionResponse,
} from '@parity/truapi';
import { decideBehavior } from '../../types.js';
import type { HostState } from './state.js';

function record(state: HostState, tag: string, value: unknown, approved: boolean): void {
  if (approved) {
    state.grantedPermissions.add(tag);
  }
  state.permissionLog.push({ tag, value, approved, timestamp: Date.now() });
  console.log(`[test-host] Permission ${approved ? 'granted' : 'denied'}:`, tag);
}

export function createPermissionCallbacks(state: HostState): {
  devicePermission(request: HostDevicePermissionRequest): Promise<HostDevicePermissionResponse>;
  remotePermission(request: RemotePermissionRequest): Promise<RemotePermissionResponse>;
} {
  return {
    async devicePermission(request: HostDevicePermissionRequest): Promise<HostDevicePermissionResponse> {
      const approved = decideBehavior(state.permissionBehavior, { tag: request, value: undefined });
      record(state, request, undefined, approved);
      return { granted: approved };
    },

    async remotePermission(request: RemotePermissionRequest): Promise<RemotePermissionResponse> {
      const { tag, value } = request.permission;
      const approved = decideBehavior(state.permissionBehavior, { tag, value });
      record(state, tag, value, approved);
      return { granted: approved };
    },
  };
}
