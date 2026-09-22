import { describe, expect, it } from 'vitest';
import { createPermissionCallbacks } from './permissions.js';
import { createHostState } from './state.js';

describe('permission callbacks', () => {
  it('grants for good by default, and records the lifetime', async () => {
    const state = createHostState();
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission({ permission: { tag: 'ChainSubmit' } })).toBe('AllowAlways');
    expect(state.permissionLog[0]).toMatchObject({
      tag: 'ChainSubmit',
      approved: true,
      decision: 'AllowAlways',
    });
    expect(state.grantedPermissions.has('ChainSubmit')).toBe(true);
  });

  it('hands out a one-use grant under approve-once', async () => {
    const state = createHostState();
    state.permissionBehavior = 'approve-once';
    const { remotePermission, devicePermission } = createPermissionCallbacks(state);

    expect(await remotePermission({ permission: { tag: 'ChainSubmit' } })).toBe('AllowOnce');
    expect(await devicePermission('Camera')).toBe('AllowOnce');
    // A one-use grant is still a grant: the capability has to be open for the
    // single use the core is about to make of it.
    expect([...state.grantedPermissions]).toEqual(['ChainSubmit', 'Camera']);
    expect(state.permissionLog.map((e) => e.approved)).toEqual([true, true]);
  });

  it('denies every request under reject-all', async () => {
    const state = createHostState();
    state.permissionBehavior = 'reject-all';
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission({ permission: { tag: 'ChainSubmit' } })).toBe('Deny');
    expect(state.permissionLog[0]).toMatchObject({ approved: false, decision: 'Deny' });
    expect(state.grantedPermissions.size).toBe(0);
  });

  it('reads a boolean from the function form as a lasting answer', async () => {
    const state = createHostState();
    state.permissionBehavior = (request) => request.tag === 'ChainSubmit';
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission({ permission: { tag: 'ChainSubmit' } })).toBe('AllowAlways');
    expect(await remotePermission({ permission: { tag: 'StatementSubmit' } })).toBe('Deny');
  });

  it('takes a decision straight from the function form', async () => {
    const state = createHostState();
    state.permissionBehavior = (request) => (request.tag === 'ChainSubmit' ? 'AllowOnce' : 'Deny');
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission({ permission: { tag: 'ChainSubmit' } })).toBe('AllowOnce');
    expect(await remotePermission({ permission: { tag: 'StatementSubmit' } })).toBe('Deny');
  });

  it('shows the device request itself to the function form', async () => {
    const state = createHostState();
    const seen: string[] = [];
    state.permissionBehavior = (request) => {
      seen.push(request.tag);
      return request.tag !== 'Camera';
    };
    const { devicePermission } = createPermissionCallbacks(state);

    expect(await devicePermission('Camera')).toBe('Deny');
    expect(await devicePermission('Microphone')).toBe('AllowAlways');
    expect(seen).toEqual(['Camera', 'Microphone']);
  });
});
