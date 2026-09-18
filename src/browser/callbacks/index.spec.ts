import { describe, expect, it, vi } from 'vitest';
import { createLoopbackStore } from '../loopback-chain.js';
import { createHostCallbacks, createHostState } from './index.js';

const build = () =>
  createHostCallbacks({
    state: createHostState(),
    store: createLoopbackStore(),
    networks: [],
  });

describe('host callbacks', () => {
  it('supplies every required group', () => {
    const callbacks = build();
    for (const group of [
      'navigation', 'notifications', 'permissions', 'features', 'productStorage',
      'coreStorage', 'chain', 'auth', 'userConfirmation', 'theme', 'locale', 'preimage',
    ]) {
      expect(callbacks).toHaveProperty(group);
    }
  });

  // These two are optional on `RequiredHostCallbacks`, so dropping either one
  // still typechecks — only a test notices the group going missing.
  it('supplies the optional groups this host chooses to serve', () => {
    const callbacks = build();
    expect(callbacks).toHaveProperty('chat');
    expect(callbacks).toHaveProperty('permissionStatus');
  });

  it('records navigation attempts instead of navigating', async () => {
    const state = createHostState();
    const callbacks = createHostCallbacks({
      state, store: createLoopbackStore(), networks: [],
    });
    await callbacks.navigation.navigateTo('https://example.test/x');
    expect(state.navigationLog).toHaveLength(1);
    expect(state.navigationLog[0].url).toBe('https://example.test/x');
  });

  it('approves permissions by default and remembers the grant', async () => {
    const state = createHostState();
    const callbacks = createHostCallbacks({
      state, store: createLoopbackStore(), networks: [],
    });
    const response = await callbacks.permissions.remotePermission({ permission: { tag: 'ChainSubmit' } });
    expect(response).toBeTruthy();
    expect(state.permissionLog[0].approved).toBe(true);
  });

  it('rejects every permission under reject-all', async () => {
    const state = createHostState();
    state.permissionBehavior = 'reject-all';
    const callbacks = createHostCallbacks({
      state, store: createLoopbackStore(), networks: [],
    });
    await callbacks.permissions.remotePermission({ permission: { tag: 'ChainSubmit' } });
    expect(state.permissionLog[0].approved).toBe(false);
  });

  it('round-trips product storage', async () => {
    const callbacks = build();
    const value = new TextEncoder().encode('v');
    await callbacks.productStorage.write('k', value);
    expect(await callbacks.productStorage.read('k')).toEqual(value);
    await callbacks.productStorage.clear('k');
    expect(await callbacks.productStorage.read('k')).toBeUndefined();
  });
});
