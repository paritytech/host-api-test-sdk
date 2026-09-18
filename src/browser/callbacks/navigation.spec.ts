import { describe, expect, it } from 'vitest';
import { createNavigationCallbacks } from './navigation.js';
import { createHostState } from './state.js';

describe('navigation callbacks', () => {
  it('logs and accepts by default', async () => {
    const state = createHostState();
    await createNavigationCallbacks(state).navigateTo('https://example.com/a');
    expect(state.navigationLog).toHaveLength(1);
  });

  it('throws under reject-all, and still logs the attempt', async () => {
    const state = createHostState();
    state.navigationBehavior = 'reject-all';
    await expect(
      createNavigationCallbacks(state).navigateTo('https://example.com/a'),
    ).rejects.toThrow(/refused/i);
    expect(state.navigationLog).toHaveLength(1);
  });

  it('asks the function form, which sees the url', async () => {
    const state = createHostState();
    state.navigationBehavior = (request) => !request.url.includes('blocked');
    const { navigateTo } = createNavigationCallbacks(state);
    await expect(navigateTo('https://example.com/blocked')).rejects.toThrow(/refused/i);
    await navigateTo('https://example.com/ok');
    expect(state.navigationLog).toHaveLength(2);
  });
});
