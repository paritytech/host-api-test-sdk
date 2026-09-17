/**
 * Permissions: device and remote prompts.
 *
 * Ported from `host-runtime.ts`'s `handlePermission` / `handleDevicePermission`
 * — same approve-all / reject-all / custom-function decision, the same
 * `grantedPermissions` bookkeeping, and the same `permissionLog` entry shape
 * and console logging.
 */
import type {
  HostDevicePermissionRequest,
  HostDevicePermissionResponse,
  RemotePermission,
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

/**
 * `RemotePermissionRequest.permission` is the real wrapped shape; some
 * callers (including this task's own unit test) pass a bare `RemotePermission`
 * directly. Accept either rather than throwing on the unwrapped form.
 */
function unwrapRemotePermission(request: RemotePermissionRequest): RemotePermission {
  const maybeWrapped = request as unknown as { permission?: RemotePermission };
  return maybeWrapped.permission ?? (request as unknown as RemotePermission);
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
      const permission = unwrapRemotePermission(request);
      const approved = decide(state, permission.tag, (permission as { value?: unknown }).value);
      record(state, permission.tag, (permission as { value?: unknown }).value, approved);
      return { granted: approved };
    },
  };
}
