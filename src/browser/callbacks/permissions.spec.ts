import { describe, expect, it } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createPermissionCallbacks } from './permissions.js';
import { createHostState } from './state.js';

const PRODUCT: ProductContext = { productId: 'test-product.dot', executionKind: 'App' };

describe('permission callbacks', () => {
  it('grants for good by default, and records the lifetime', async () => {
    const state = createHostState();
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } })).toBe('AllowAlways');
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

    expect(await remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } })).toBe('AllowOnce');
    expect(await devicePermission(PRODUCT, 'Camera')).toBe('AllowOnce');
    // A one-use grant is still a grant: the capability has to be open for the
    // single use the core is about to make of it.
    expect([...state.grantedPermissions]).toEqual(['ChainSubmit', 'Camera']);
    expect(state.permissionLog.map((e) => e.approved)).toEqual([true, true]);
  });

  it('denies every request under reject-all', async () => {
    const state = createHostState();
    state.permissionBehavior = 'reject-all';
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } })).toBe('Deny');
    expect(state.permissionLog[0]).toMatchObject({ approved: false, decision: 'Deny' });
    expect(state.grantedPermissions.size).toBe(0);
  });

  it('reads a boolean from the function form as a lasting answer', async () => {
    const state = createHostState();
    state.permissionBehavior = (request) => request.tag === 'ChainSubmit';
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } })).toBe('AllowAlways');
    expect(await remotePermission(PRODUCT, { permission: { tag: 'StatementSubmit' } })).toBe('Deny');
  });

  it('takes a decision straight from the function form', async () => {
    const state = createHostState();
    state.permissionBehavior = (request) => (request.tag === 'ChainSubmit' ? 'AllowOnce' : 'Deny');
    const { remotePermission } = createPermissionCallbacks(state);

    expect(await remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } })).toBe('AllowOnce');
    expect(await remotePermission(PRODUCT, { permission: { tag: 'StatementSubmit' } })).toBe('Deny');
  });

  it('shows the device request itself to the function form', async () => {
    const state = createHostState();
    const seen: string[] = [];
    state.permissionBehavior = (request) => {
      seen.push(request.tag);
      return request.tag !== 'Camera';
    };
    const { devicePermission } = createPermissionCallbacks(state);

    expect(await devicePermission(PRODUCT, 'Camera')).toBe('Deny');
    expect(await devicePermission(PRODUCT, 'Microphone')).toBe('AllowAlways');
    expect(seen).toEqual(['Camera', 'Microphone']);
  });

  // The core names the asking product on both prompts since truapi 0.21, so a
  // suite can tell which product a grant went to.
  it('records which product asked, for device and remote prompts alike', async () => {
    const state = createHostState();
    const { remotePermission, devicePermission } = createPermissionCallbacks(state);
    const other: ProductContext = { productId: 'other.dot', executionKind: 'Widget' };

    await remotePermission(PRODUCT, { permission: { tag: 'ChainSubmit' } });
    await devicePermission(other, 'Camera');

    expect(state.permissionLog.map((e) => [e.productId, e.tag])).toEqual([
      ['test-product.dot', 'ChainSubmit'],
      ['other.dot', 'Camera'],
    ]);
  });
});
