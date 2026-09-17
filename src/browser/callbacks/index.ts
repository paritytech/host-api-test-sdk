/**
 * Composes the twelve required TrUAPI host callback groups, plus the
 * optional `chat` group, from the small, single-responsibility modules in
 * this directory.
 *
 * `chat` is included (unlike `permissionStatus`/`pocket`) because Task 14's
 * control API (`getChatRooms`, `getChatBots`, `getChatMessageLog`,
 * `clearChatState`, `injectChatAction`) reads chat state that only this
 * group's handlers populate.
 *
 * `auth` and `userConfirmation` have no pre-migration analogue substantial
 * enough to warrant their own file (RFC-0009 login and per-action review
 * land in later tasks), so they are wired directly here: `auth` is a no-op
 * (satisfies `Required<AuthPresenter>` without inventing session UI), and
 * `userConfirmation` approves unconditionally, matching this file's
 * default-approve stance elsewhere until a later task adds a behavior
 * switch for it.
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
      authStateChanged: () => {},
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
