/** Permissions: device and remote prompts, answered from `state.permissionBehavior`. */
import type { HostDevicePermissionRequest, RemotePermissionRequest } from '@parity/truapi';
import type { PermissionDecision } from '@parity/truapi-host';
import { decideConsent } from '../../types.js';
import type { HostState } from './state.js';

function record(state: HostState, tag: string, value: unknown, decision: PermissionDecision): void {
  const approved = decision !== 'Deny';
  if (approved) {
    // A one-use grant is recorded too: the capability has to be open for the
    // single use the core is about to make of it, and nothing here persists
    // past the run anyway.
    state.grantedPermissions.add(tag);
  }
  state.permissionLog.push({ tag, value, approved, decision, timestamp: Date.now() });
  console.log(`[test-host] Permission ${decision}:`, tag);
}

export function createPermissionCallbacks(state: HostState): {
  devicePermission(request: HostDevicePermissionRequest): Promise<PermissionDecision>;
  remotePermission(request: RemotePermissionRequest): Promise<PermissionDecision>;
} {
  return {
    async devicePermission(request: HostDevicePermissionRequest): Promise<PermissionDecision> {
      const decision = decideConsent(state.permissionBehavior, { tag: request, value: undefined });
      record(state, request, undefined, decision);
      return decision;
    },

    async remotePermission(request: RemotePermissionRequest): Promise<PermissionDecision> {
      const { tag, value } = request.permission;
      const decision = decideConsent(state.permissionBehavior, { tag, value });
      record(state, tag, value, decision);
      return decision;
    },
  };
}
