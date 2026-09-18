import type {
  ChainIdentifier,
  ChatActionPayload,
  HostChatActionSubscribeItem,
} from '@parity/truapi';
// Must stay type-only and erased at emit: `@parity/truapi-host` is a
// devDependency, so a published declaration naming it would not resolve.
import type { ProductExecutionKind as CoreProductExecutionKind } from '@parity/truapi-host';

/** A `0x`-prefixed hex string. */
export type HexString = `0x${string}`;

/** A network's protocol role, as `features.supportedChains()` reports it. */
export type { ChainIdentifier };

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

/** How the test host answers remote permission requests; `'approve-all'` is the default. */
export type PermissionBehavior = 'approve-all' | 'reject-all' | ((tag: string, value: unknown) => boolean);

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
  clearChatState(): void;
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

  dispose(): void;
}
