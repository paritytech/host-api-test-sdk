/** Navigation: logs what the product tried to open instead of navigating. */
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
