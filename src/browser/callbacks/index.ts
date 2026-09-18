/**
 * Composes the twelve required TrUAPI host callback groups, plus the
 * optional `chat` group, from the small, single-responsibility modules in
 * this directory.
 *
 * `chat` is included (unlike `permissionStatus`/`pocket`) because the control
 * API in `control-api.ts` (`getChatRooms`, `getChatBots`,
 * `getChatMessageLog`, `clearChatState`, `injectChatAction`) reads chat state
 * that only this group's handlers populate.
 *
 * `auth` and `userConfirmation` are wired inline rather than given files of
 * their own, because neither has any behaviour to put in one:
 *
 *  - `auth.authStateChanged` records what the core reports into `state`.
 *    This host has no login UI to drive from it — it mints its own SSO
 *    session at boot — but the core IS the authority on whether that session
 *    is up, and `getChainStatus()` answers from this one field rather than
 *    from a status this host tries to keep in step by hand.
 *  - `userConfirmation.confirmUserAction` always approves. Per-action review
 *    is a human prompt, and a host whose whole purpose is unattended
 *    auto-signing has nobody to ask; approving is the same default-approve
 *    stance the permission group takes, and there is deliberately no control
 *    to flip it.
 */
import type { RequiredHostCallbacks } from '@parity/truapi-host';
import type { LoopbackStore } from '../loopback-chain.js';
import { type ChainRuntimeConfig, createChainCallbacks } from './chain.js';
import { createChatCallbacks } from './chat.js';
import { createFeatureCallbacks } from './features.js';
import { createNavigationCallbacks } from './navigation.js';
import { createNotificationCallbacks } from './notifications.js';
import { createLocaleCallbacks, createPreimageCallbacks, createThemeCallbacks } from './passive.js';
import { createPermissionCallbacks } from './permissions.js';
import { createCoreStorageCallbacks, createProductStorageCallbacks } from './storage.js';
import type { HostState } from './state.js';

export { createHostState, type HostState } from './state.js';
export type { ChainRuntimeConfig } from './chain.js';

export interface CreateHostCallbacksOptions {
  state: HostState;
  store: LoopbackStore;
  networks: ChainRuntimeConfig[];
}

export function createHostCallbacks(options: CreateHostCallbacksOptions): RequiredHostCallbacks {
  const { state, store, networks } = options;

  return {
    navigation: createNavigationCallbacks(state),
    notifications: createNotificationCallbacks(state),
    permissions: createPermissionCallbacks(state),
    features: createFeatureCallbacks(networks),
    productStorage: createProductStorageCallbacks(),
    coreStorage: createCoreStorageCallbacks(),
    chain: createChainCallbacks({ store, networks }),
    auth: {
      authStateChanged: (authState) => {
        state.authState = authState;
      },
    },
    userConfirmation: {
      confirmUserAction: async () => true,
    },
    theme: createThemeCallbacks(state),
    locale: createLocaleCallbacks(state),
    preimage: createPreimageCallbacks(state),
    chat: createChatCallbacks(state),
  };
}
