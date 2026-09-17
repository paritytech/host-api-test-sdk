/**
 * Navigation: records intents instead of navigating.
 *
 * Ported from `host-runtime.ts`'s `handleNavigateTo` — real hosts parse the
 * URL and route within the app or open it externally; this host just logs
 * what the product tried, so tests can assert on it.
 */
import type { HostState } from './state.js';

export function createNavigationCallbacks(state: HostState): { navigateTo(url: string): Promise<void> } {
  return {
    async navigateTo(url: string): Promise<void> {
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('Empty URL');
      }
      state.navigationLog.push({ url, timestamp: Date.now() });
      console.log('[test-host] Navigation requested:', url);
    },
  };
}
