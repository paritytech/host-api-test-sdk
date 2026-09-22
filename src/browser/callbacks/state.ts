/**
 * Mutable state backing the host callback groups. A bag of public fields rather
 * than a class because `control-api.ts` mutates them directly.
 */

import type { AuthState, DevicePermissionStatus, HostChainEntry } from '@parity/truapi-host';
import type {
  NavigationBehavior,
  NotificationBehavior,
  OperationEntry,
  PermissionBehavior,
  PermissionDecision,
  UserConfirmationBehavior,
  UserConfirmationLogEntry,
} from '../../types.js';

export type { PermissionBehavior };

export interface PermissionLogEntry {
  tag: string;
  value: unknown;
  /** `false` only for `'Deny'`: a one-use grant is still an approval. */
  approved: boolean;
  decision: PermissionDecision;
  timestamp: number;
}

export interface NavigationLogEntry {
  url: string;
  timestamp: number;
}

export interface NotificationLogEntry {
  id: number;
  text: string;
  deeplink: string | undefined;
  scheduledAt: bigint | undefined;
  cancelled: boolean;
  timestamp: number;
}

/** Structurally identical to the generated `HostThemeSubscribeItem`. */
export interface Theme {
  name: { tag: 'Default'; value?: undefined } | { tag: 'Custom'; value: string };
  variant: 'Light' | 'Dark';
}

export interface PreimageEntry {
  /** Lowercased `0x`-hex blake2b-256 key. */
  key: string;
  value: Uint8Array;
  /** True when submitted by the product rather than seeded by a test. */
  fromProduct: boolean;
  timestamp: number;
}

/** Carries `name`/`icon` for `getChatRooms()`; the core's own `ChatRoom` has neither. */
export interface ChatRoom {
  roomId: string;
  name: string;
  icon: string;
  participatingAs: 'RoomHost' | 'Bot';
}

export interface ChatBot {
  botId: string;
  name: string;
  icon: string;
}

export interface ChatMessageLogEntry {
  roomId: string;
  messageId: string;
  /** Unmodified payload as received from the product. */
  payload: unknown;
  timestamp: number;
}

export interface HostState {
  /** The core's last `auth.authStateChanged` report; `undefined` before the first. */
  authState: AuthState | undefined;

  permissionBehavior: PermissionBehavior;
  grantedPermissions: Set<string>;
  permissionLog: PermissionLogEntry[];
  /** Device-permission type → reported status; unset types report the default. */
  devicePermissionStatuses: Map<string, DevicePermissionStatus>;
  navigationLog: NavigationLogEntry[];
  notificationLog: NotificationLogEntry[];

  /** How `navigation.navigateTo` answers; `'approve-all'` by default. */
  navigationBehavior: NavigationBehavior;
  /** How `notifications.pushNotification` answers; `'approve-all'` by default. */
  notificationBehavior: NotificationBehavior;

  /** How `userConfirmation.confirmUserAction` answers; `'approve-all'` by default. */
  userConfirmationBehavior: UserConfirmationBehavior;
  /** Every review the core asked the host to confirm. */
  userConfirmationLog: UserConfirmationLogEntry[];

  theme: Theme;
  /** Active `theme.subscribeTheme()` listeners; notified when `theme` changes. */
  themeSubscribers: Set<(theme: Theme) => void>;

  /** BCP 47 language tag. */
  locale: string;
  /** Active `locale.subscribeLocale()` listeners; notified when `locale` changes. */
  localeSubscribers: Set<(locale: string) => void>;

  /** Known preimages, keyed the same way as `preimageSubscribers`. */
  preimages: Map<string, PreimageEntry>;
  /** Listeners waiting on one preimage key, keyed by lowercased `0x`-hex. */
  preimageSubscribers: Map<string, Set<(value: Uint8Array | undefined) => void>>;

  /** Feature tag → forced answer; absent means fall back to the derived one. */
  featureOverrides: Map<string, boolean>;
  /** Replaces the derived chain set entirely when set. */
  supportedChainsOverride?: HostChainEntry[];

  /** What `productStorage` serves; seedable so a product can resume from prior state. */
  productStorage: Map<string, Uint8Array>;
  /**
   * Listeners on one product-storage key, keyed exactly as the core namespaced
   * it — the same spelling `productStorage` uses, since the core namespaces
   * before calling either.
   */
  productStorageSubscribers: Map<string, Set<(value: Uint8Array | undefined) => void>>;

  /** Pending operations still open, by id. `endOperation` removes an entry. */
  openOperations: Map<number, OperationEntry>;
  /** Every operation opened, in order, sharing its entry object with `openOperations`. */
  operationLog: OperationEntry[];
  /** Next id `beginOperation` hands out. Ids are never reused within a run. */
  nextOperationId: number;

  /** One flat namespace: chat state is not partitioned per product. */
  chatRooms: Map<string, ChatRoom>;
  chatBots: Map<string, ChatBot>;
  chatMessageLog: ChatMessageLogEntry[];
  /** Next `msg-<n>` suffix; reset to 1 by `clearChat()`. */
  nextChatMessageId: number;
  /** Active `chat.subscribeChatRooms()` listeners; notified on every room-list change. */
  chatRoomSubscribers: Set<(rooms: Array<{ roomId: string; participatingAs: 'RoomHost' | 'Bot' }>) => void>;
}

export function createHostState(): HostState {
  return {
    authState: undefined,
    permissionBehavior: 'approve-all',
    grantedPermissions: new Set(),
    permissionLog: [],
    devicePermissionStatuses: new Map(),
    navigationLog: [],
    notificationLog: [],

    navigationBehavior: 'approve-all',
    notificationBehavior: 'approve-all',

    userConfirmationBehavior: 'approve-all',
    userConfirmationLog: [],

    theme: { name: { tag: 'Default', value: undefined }, variant: 'Light' },
    themeSubscribers: new Set(),

    locale: 'en',
    localeSubscribers: new Set(),

    preimages: new Map(),
    preimageSubscribers: new Map(),

    featureOverrides: new Map(),
    supportedChainsOverride: undefined,

    productStorage: new Map(),
    productStorageSubscribers: new Map(),

    openOperations: new Map(),
    operationLog: [],
    nextOperationId: 1,

    chatRooms: new Map(),
    chatBots: new Map(),
    chatMessageLog: [],
    nextChatMessageId: 1,
    chatRoomSubscribers: new Set(),
  };
}
