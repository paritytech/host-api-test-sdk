import type {
  ChainIdentifier,
  ChatActionPayload,
  HostChatActionSubscribeItem,
  HostDevicePermissionRequest,
} from '@parity/truapi';
// Must stay type-only and erased at emit: `@parity/truapi-host` is a
// devDependency, so a published declaration naming it would not resolve.
import type {
  DevicePermissionStatus as CoreDevicePermissionStatus,
  HostChainEntry,
  ProductExecutionKind as CoreProductExecutionKind,
} from '@parity/truapi-host';

/** A `0x`-prefixed hex string. */
export type HexString = `0x${string}`;

/** A network's protocol role, as `features.supportedChains()` reports it. */
export type { ChainIdentifier };

/** Which device capability a permission request or status names, e.g. `'Camera'`. */
export type { HostDevicePermissionRequest };

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

/**
 * Trusted kind of executable the host declares the product to be. `Worker` is
 * the only kind the core lets serve Chat — it denies every Chat entry point for
 * `App` and `Widget`.
 */
export type ProductExecutionKind = 'App' | 'Widget' | 'Worker';

/** Compile-time guard: this mirror must equal the core's enum. */
type _ProductExecutionKindMirrorsCore = Expect<
  Equal<ProductExecutionKind, CoreProductExecutionKind>
>;

/** One chain `features.supportedChains()` advertises. */
export interface ChainEntry {
  identifier: ChainIdentifier;
  genesisHash: HexString;
}

/** Compile-time guard: this mirror must equal the core's chain-set entry. */
type _ChainEntryMirrorsCore = Expect<Equal<ChainEntry, HostChainEntry>>;

/** Current OS status of a device permission, as `permissionStatus.devicePermissionStatus` reports it. */
export type DevicePermissionStatus = 'Granted' | 'Denied' | 'NotDetermined' | 'NotApplicable';

/** Compile-time guard: this mirror must equal the core's device-permission status. */
type _DevicePermissionStatusMirrorsCore = Expect<
  Equal<DevicePermissionStatus, CoreDevicePermissionStatus>
>;

export interface NetworkConfig {
  id: string;
  name: string;
  genesisHash: HexString;
  rpcUrl: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Protocol role, if known. A network that omits it is left out of `supportedChains()`. */
  chain?: ChainIdentifier;
}

/**
 * One inbound chat action, as `injectChatAction` delivers it to the product.
 * Aliasing the protocol type puts `@parity/truapi` in the published types, so
 * it must stay a real `dependency`.
 */
export type ChatActionInput = HostChatActionSubscribeItem;

export type { ChatActionPayload };

export type DevAccountName = 'alice' | 'bob' | 'charlie' | 'dave' | 'eve' | 'ferdie';

export interface DevAccountInfo {
  name: string;
  /**
   * Hard junctions under the dev seed (`'//Alice//myapp'`) — NOT a polkadot-js
   * SURI. The string is split on `//` and each segment is one hard-junction
   * label verbatim; a `/` is part of the label, and a mnemonic or hex seed is
   * read as a label too (a short one silently derives an unintended account).
   */
  uri: string;
}

export interface TestHostServer {
  /** URL of the test host page (e.g. http://localhost:43210) */
  url: string;
  /** Stop the server */
  close(): Promise<void>;
}

/** A named dev account ('alice') or a custom account with a display name and Substrate URI. */
export type Account = DevAccountName | DevAccountInfo;

export interface CreateTestHostOptions {
  /** URL of the product to embed (e.g. http://localhost:3001) */
  productUrl: string;
  /**
   * The account roster (default: `['alice']`). The FIRST entry is the active
   * identity — the SSO session is minted for it and it is the only account that
   * signs; the rest are targets `switchAccount` resolves case-insensitively.
   */
  accounts?: Account[];
  /** Networks the host can route, matched by genesis hash. */
  networks?: NetworkConfig[];
  /** Port to listen on (default: 0 = random available port) */
  port?: number;
  /**
   * Trusted executable kind the host declares for the product (default `'App'`).
   * Set `'Worker'` to exercise Chat, which the core serves for no other kind.
   */
  executionKind?: ProductExecutionKind;
  /**
   * Map a product's account SUBTREE to an account, keyed by bare product id
   * (`"myapp.dot"`). One entry moves ALL of that product's accounts, since the
   * core derives each index from the subtree. Per-index keys throw.
   */
  productAccounts?: Record<string, Account>;
  /** Host state applied before the product loads. */
  initialState?: InitialState;
  /** Decision policies applied before the product loads. */
  behaviors?: InitialBehaviors;
}

export interface SigningLogEntry {
  type: 'payload' | 'raw' | 'createTransaction';
  payload: unknown;
  timestamp: number;
}

export interface PermissionLogEntry {
  tag: string;
  value: unknown;
  approved: boolean;
  timestamp: number;
}

export interface NavigationLogEntry {
  url: string;
  timestamp: number;
}

export interface NotificationLogEntry {
  /** Host-assigned id for this notification (incrementing u32). Used by `cancel`. */
  id: number;
  text: string;
  deeplink: string | undefined;
  /** Future delivery time in epoch-ms, or undefined for immediate. */
  scheduledAt: bigint | undefined;
  /** Set true once the product calls pushNotificationCancel with this id. */
  cancelled: boolean;
  timestamp: number;
}

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

export interface PreimageEntry {
  /** Hex-encoded blake2b-256 hash of the value. */
  key: HexString;
  value: Uint8Array;
  /** When true, this preimage was submitted by the product via hostApi.preimageSubmit. */
  fromProduct: boolean;
  timestamp: number;
}

/** Host theme, as the `host_theme_subscribe` payload carries it. */
export type Theme = {
  name: { tag: 'Default'; value: undefined } | { tag: 'Custom'; value: string };
  variant: 'Light' | 'Dark';
};

/** Shorthand inputs accepted by `setTheme` — `'light' | 'dark'` map to `{ name: Default, variant: Light/Dark }`. */
export type ThemeInput = 'light' | 'dark' | Theme;

/**
 * How the host answers one kind of request. `fn` receives the request and
 * returns the answer, so a test can be selective without a matcher language.
 */
export type Behavior<Req, Res> = 'approve-all' | 'reject-all' | ((request: Req) => Res);

/** The one reading of a `Behavior`, so the named modes cannot drift between handlers. */
export function decideBehavior<Req>(behavior: Behavior<Req, boolean>, request: Req): boolean {
  if (behavior === 'approve-all') return true;
  if (behavior === 'reject-all') return false;
  return behavior(request);
}

/** How the test host answers remote permission requests; `'approve-all'` is the default. */
export type PermissionBehavior = Behavior<{ tag: string; value: unknown }, boolean>;

/** One `confirmUserAction` review the host was asked to answer. */
export interface UserConfirmationLogEntry {
  /** The review's variant tag, e.g. `SignRaw`. */
  tag: string;
  approved: boolean;
  timestamp: number;
}

/** How the host answers `confirmUserAction`; `'approve-all'` is the default. */
export type UserConfirmationBehavior = Behavior<{ tag: string; value: unknown }, boolean>;

/** How the host answers `navigateTo`; `'approve-all'` is the default. */
export type NavigationBehavior = Behavior<{ url: string }, boolean>;

/** How the host answers `pushNotification`; `'approve-all'` is the default. */
export type NotificationBehavior = Behavior<{ text: string }, boolean>;

/** Host state applied before the product's first frame. */
export interface InitialState {
  theme?: ThemeInput;
  locale?: string;
  /** Feature tag → forced `featureSupported` answer. */
  features?: Record<string, boolean>;
  /** Product-storage entries, stored as UTF-8. */
  productStorage?: Record<string, string>;
  /** Device-permission type → reported status. */
  devicePermissionStatuses?: Record<string, DevicePermissionStatus>;
  /** Replaces the chain set derived from `networks`. */
  supportedChains?: ChainEntry[];
  grantedPermissions?: string[];
}

/**
 * Decision policies applied before the product's first frame. A function
 * cannot cross into the page config, so only the two named modes are accepted.
 */
export interface InitialBehaviors {
  permission?: 'approve-all' | 'reject-all';
  userConfirmation?: 'approve-all' | 'reject-all';
  navigation?: 'approve-all' | 'reject-all';
  notification?: 'approve-all' | 'reject-all';
}

/** Shape of window.__TEST_HOST__ — shared between browser bundle and Playwright fixture. */
export interface TestHostAPI {
  switchAccount(name: string): Promise<void>;
  setAccounts(names: string[]): Promise<void>;
  getSigningLog(): SigningLogEntry[];
  clearSigningLog(): void;
  /**
   * The PRODUCT connection — `'connected'` once a frame has arrived from it,
   * back to `'disconnected'` on an account switch. The gate to wait on before
   * driving a product.
   */
  getConnectionStatus(): string;
  /**
   * This HOST's session: `'connecting' | 'connected' | 'disconnected'`. Named
   * for the chain because the in-page loopback People store that carries
   * signing is up exactly when the session is.
   */
  getChainStatus(): string;
  /** Set how the host responds to remote permission requests. */
  setPermissionBehavior(behavior: PermissionBehavior): void;
  /** Pre-grant a permission without the product requesting it. */
  grantPermission(tag: string): void;
  /** Revoke a previously granted permission. */
  revokePermission(tag: string): void;
  /** List currently granted permissions. */
  getGrantedPermissions(): string[];
  /** Get the log of all permission requests and their outcomes. */
  getPermissionLog(): PermissionLogEntry[];
  /** Clear the permission log. */
  clearPermissionLog(): void;
  /**
   * Force the OS status `permissionStatus.devicePermissionStatus` reports for
   * one device permission; `undefined` restores the default status.
   */
  setDevicePermissionStatus(
    type: HostDevicePermissionRequest,
    status: DevicePermissionStatus | undefined,
  ): void;
  /** The forced device-permission statuses currently in effect. */
  getDevicePermissionStatuses(): Record<string, DevicePermissionStatus>;
  /** Get the log of navigation attempts (hostApi.navigateTo) from the product. */
  getNavigationLog(): NavigationLogEntry[];
  /** Clear the navigation log. */
  clearNavigationLog(): void;
  /** Get the log of push notifications (hostApi.pushNotification) from the product. */
  getNotificationLog(): NotificationLogEntry[];
  /** Clear the notification log. */
  clearNotificationLog(): void;
  /** List chat rooms the product has created in the current session. */
  getChatRooms(): ChatRoom[];
  /** List chat bots the product has registered in the current session. */
  getChatBots(): ChatBot[];
  /** Get the log of messages the product has posted to chat rooms. */
  getChatMessageLog(): ChatMessageLogEntry[];
  /** Clear rooms, bots and the message log. Live streams stay open and are pushed the empty list. */
  clearChat(): void;
  /** Add a chat room without the product creating it; live subscribers are notified. */
  seedChatRoom(room: ChatRoom): void;
  /** Add a chat bot without the product registering it. */
  seedChatBot(bot: ChatBot): void;
  /**
   * Inject an incoming chat action into the product. Buffered until the product
   * subscribes; rejects if the payload or the connection cannot carry it.
   */
  injectChatAction(action: ChatActionInput): Promise<void>;
  /** List all preimages known to the test host (submitted by product + seeded by test). */
  getPreimages(): PreimageEntry[];
  /** Seed a preimage; returns its blake2b-256 key and notifies `preimageLookup` subscribers. */
  seedPreimage(value: Uint8Array): HexString;
  /** Clear all preimages. */
  clearPreimages(): void;
  /** Get the current theme. */
  getTheme(): Theme;
  /** Set the theme and notify subscribers. */
  setTheme(theme: ThemeInput): void;
  /** The BCP 47 tag the host reports to products, e.g. `en`, `pt-BR`. */
  getLocale(): string;
  /** Replace the reported locale and push it to live subscribers. */
  setLocale(languageTag: string): void;
  /** Set how the host answers `confirmUserAction`. */
  setUserConfirmationBehavior(behavior: UserConfirmationBehavior): void;
  /** Every review the core asked the host to confirm. */
  getUserConfirmationLog(): UserConfirmationLogEntry[];
  /** Drop the confirmation log. */
  clearUserConfirmationLog(): void;
  /** Set how the host answers `navigateTo`. */
  setNavigationBehavior(behavior: NavigationBehavior): void;
  /** Set how the host answers `pushNotification`. */
  setNotificationBehavior(behavior: NotificationBehavior): void;
  /** Force `featureSupported` for one feature tag; `undefined` restores the derived answer. */
  setFeatureSupport(feature: string, supported: boolean | undefined): void;
  /** The forced answers currently in effect. */
  getFeatureSupport(): Record<string, boolean>;
  /** Replace the advertised chain set; `undefined` restores the derived one. */
  setSupportedChains(chains: ChainEntry[] | undefined): void;
  /** The chain set in effect — the override if one is set, the derived one otherwise. */
  getSupportedChains(): ChainEntry[];
  /**
   * Pre-populate one product-storage entry; the value is stored as UTF-8. The
   * core namespaces keys per product, so `key` must be one `getProductStorage()`
   * reported — a product-level key it never wrote is not resolvable here.
   */
  seedProductStorage(key: string, value: string): void;
  /** Every product-storage entry, decoded as UTF-8. */
  getProductStorage(): Record<string, string>;
  /** Drop every product-storage entry. */
  clearProductStorage(): void;

  dispose(): void;
}
