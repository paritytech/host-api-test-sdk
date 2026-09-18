/**
 * Composes the required TrUAPI host callback groups, plus the optional `chat`
 * one, which is included because the control API reads state only its handlers
 * populate.
 *
 * `auth.authStateChanged` is recorded because the core is the authority on
 * whether this host's session is up; `getChainStatus()` answers from it rather
 * than from a status kept in step by hand.
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
import { createPermissionStatusCallbacks } from './permission-status.js';
import { createCoreStorageCallbacks, createProductStorageCallbacks } from './storage.js';
import { createUserConfirmationCallbacks } from './user-confirmation.js';
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
    permissionStatus: createPermissionStatusCallbacks(state),
    features: createFeatureCallbacks(state, networks),
    productStorage: createProductStorageCallbacks(state),
    coreStorage: createCoreStorageCallbacks(),
    chain: createChainCallbacks({ store, networks }),
    auth: {
      authStateChanged: (authState) => {
        state.authState = authState;
      },
    },
    userConfirmation: createUserConfirmationCallbacks(state),
    theme: createThemeCallbacks(state),
    locale: createLocaleCallbacks(state),
    preimage: createPreimageCallbacks(state),
    chat: createChatCallbacks(state),
  };
}
