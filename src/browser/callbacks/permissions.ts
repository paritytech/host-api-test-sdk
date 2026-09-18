/** Permissions: device and remote prompts, answered from `state.permissionBehavior`. */
import type {
  HostDevicePermissionRequest,
  HostDevicePermissionResponse,
  RemotePermissionRequest,
  RemotePermissionResponse,
} from '@parity/truapi';
import type { HostState } from './state.js';

function decide(state: HostState, tag: string, value: unknown): boolean {
  if (state.permissionBehavior === 'approve-all') return true;
  if (state.permissionBehavior === 'reject-all') return false;
  return state.permissionBehavior(tag, value);
}

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
      const approved = decide(state, request, undefined);
      record(state, request, undefined, approved);
      return { granted: approved };
    },

    async remotePermission(request: RemotePermissionRequest): Promise<RemotePermissionResponse> {
      const { tag, value } = request.permission;
      const approved = decide(state, tag, value);
      record(state, tag, value, approved);
      return { granted: approved };
    },
  };
}
