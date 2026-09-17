// `CoreChainIdentifier` is referenced solely by the non-exported drift guard
// below, so it never reaches the emitted declarations. `ChatActionPayload`
// and `HostChatActionSubscribeItem` DO: an injected chat action is a protocol
// value, and a hand-mirrored copy of that ~120-line generated union would be
// a lie waiting to drift. See the note on `ChatActionInput`.
import type {
  ChainIdentifier as CoreChainIdentifier,
  ChatActionPayload,
  HostChatActionSubscribeItem,
} from '@parity/truapi';
// Same deal: referenced only by the drift guard under `ProductExecutionKind`,
// so it is erased at emit. It has to be, because `@parity/truapi-host` is a
// devDependency of this package — a published declaration that named it would
// not resolve for a consumer.
import type { ProductExecutionKind as CoreProductExecutionKind } from '@parity/truapi-host';

/**
 * A `0x`-prefixed hex string. Declared here rather than re-exported from a
 * host-api package so the published types stand on their own.
 */
export type HexString = `0x${string}`;

/**
 * A network's protocol role.
 *
 * Mirrors `ChainIdentifier` in `@parity/truapi`, which the browser runtime
 * reports through `features.supportedChains()`. It is spelled out here so
 * this package's published types stand alone rather than depending on a
 * package consumers do not install — and `_ChainIdentifierMirrorsCore`
 * below fails the build if the two ever drift apart.
 */
export type ChainIdentifier = 'Relay' | 'AssetHub' | 'People' | 'Bulletin';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
/** Compile-time guard, erased at emit: this mirror must equal the core's enum. */
type _ChainIdentifierMirrorsCore = Expect<Equal<ChainIdentifier, CoreChainIdentifier>>;

/**
 * Trusted kind of executable the host declares the product to be.
 *
 * `App` (the default) is a visible full-page entrypoint — what an iframe-
 * embedded product genuinely is. `Widget` is a visible embedded surface and
 * carries the same capabilities as `App`. `Worker` is a headless executable,
 * and it is the ONLY kind the core lets serve the Chat modality: every Chat
 * entry point is denied for `App` and `Widget`. So a test that drives chat
 * must ask for `executionKind: 'Worker'`.
 *
 * Mirrored here rather than re-exported for the same reason as
 * `ChainIdentifier` above — `_ProductExecutionKindMirrorsCore` fails the build
 * if the two drift.
 */
export type ProductExecutionKind = 'App' | 'Widget' | 'Worker';

/** Compile-time guard, erased at emit: this mirror must equal the core's enum. */
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
  /**
   * This network's protocol role, if known. Reported to products through
   * `supportedChains()`; a network that omits it is left out of that report
   * rather than labelled by guesswork.
   */
  chain?: ChainIdentifier;
}

/**
 * One inbound chat action, as `injectChatAction` delivers it to the product.
 *
 * An alias of the protocol's own `HostChatActionSubscribeItem` rather than a
 * copy, so the two cannot drift: the host forwards the value straight into
 * the core, which decodes it against this exact schema. Building one needs
 * `ChatActionPayload`, re-exported below.
 *
 * NOTE: this makes the published types reference `@parity/truapi`. It must be
 * a real `dependency` of this package, not a devDependency.
 */
export type ChatActionInput = HostChatActionSubscribeItem;

export type { ChatActionPayload };

export type DevAccountName = 'alice' | 'bob' | 'charlie' | 'dave' | 'eve' | 'ferdie';

export interface DevAccountInfo {
  name: string;
  /**
   * A path of HARD junctions under the dev seed.
   *
   * The host derives in-page with `@scure/sr25519` — there is no keyring — so
   * this is narrower than a polkadot-js SURI:
   *  - `'//Alice'` — dev account
   *  - `'//Alice//myapp'` — a further hard junction
   *
   * A mnemonic or a hex seed is NOT accepted and throws, and a `/` inside a
   * segment (`'//Alice//myapp/0'`) is part of that junction's label rather
   * than a polkadot-js soft junction, so it does not name the address
   * polkadot-js would give it.
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
  /** Accounts to provide (used for getLegacyAccounts and signing) */
  accounts?: Account[];
  /**
   * Networks the host can route, matched by genesis hash.
   */
  networks?: NetworkConfig[];
  /** Port to listen on (default: 0 = random available port) */
  port?: number;
  /**
   * Trusted executable kind the host declares for the embedded product
   * (default: `'App'`).
   *
   * An iframe-embedded product really is an `App`, so that is the default and
   * it is what a host should report. Set `'Worker'` only to exercise the Chat
   * modality: the core denies every Chat entry point unless the connection's
   * execution kind is `Worker`.
   */
  executionKind?: ProductExecutionKind;
  /**
   * Map a product's account SUBTREE to a specific account.
   *
   * Keys are bare product identifiers (e.g. `"myapp.dot"`). Values are dev
   * account names or custom `{ name, uri }` objects.
   *
   * The host answers one question per product — which keypair is that
   * product's subtree root — and the core derives every indexed account from
   * it itself, as a soft junction. So an entry moves ALL of a product's
   * accounts together:
   *
   * ```ts
   * productAccounts: {
   *   'myapp.dot': 'bob',                                // subtree → //Bob
   *   'other.dot': { name: 'Custom', uri: '//My//Custom' },
   * }
   * ```
   *
   * Without an entry the subtree is `//Selected//dotnsId` under the selected
   * account, and index `n` is that subtree soft-derived at `index_bytes(n)`.
   *
   * Per-index keys (`"myapp.dot/0"`) are NOT accepted and throw: the core no
   * longer asks the host for an indexed account, so such a key could not move
   * an address. Use the bare product id instead.
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
  /** Upstream 0.7.9: future delivery time in epoch-ms, or undefined for immediate. */
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

/**
 * Host theme (host_theme_subscribe payload, upstream 0.8).
 *
 * `name` selects the active theme — `Default` for the host's built-in,
 * `Custom` for a named host-specific theme. `variant` is the light/dark
 * sub-mode (note the capitalization is `'Light' | 'Dark'`, upstream-aligned).
 */
export type Theme = {
  name: { tag: 'Default'; value: undefined } | { tag: 'Custom'; value: string };
  variant: 'Light' | 'Dark';
};

/** Shorthand inputs accepted by `setTheme` — `'light' | 'dark'` map to `{ name: Default, variant: Light/Dark }`. */
export type ThemeInput = 'light' | 'dark' | Theme;

/**
 * Controls how the test host responds to remote permission requests.
 * - `'approve-all'` — auto-approve every request (default)
 * - `'reject-all'` — auto-reject every request
 * - `(tag: string, value: unknown) => boolean` — custom per-request decision
 */
export type PermissionBehavior = 'approve-all' | 'reject-all' | ((tag: string, value: unknown) => boolean);

/** Shape of window.__TEST_HOST__ — shared between browser bundle and Playwright fixture. */
export interface TestHostAPI {
  switchAccount(name: string): Promise<void>;
  setAccounts(names: string[]): Promise<void>;
  getSigningLog(): SigningLogEntry[];
  clearSigningLog(): void;
  /**
   * The PRODUCT connection: `'disconnected'` until a frame has actually
   * arrived from the embedded product, `'connected'` from then on. An account
   * switch returns it to `'disconnected'` until the product speaks again.
   * This is the readiness gate to wait on before driving a product.
   */
  getConnectionStatus(): string;
  /**
   * This HOST's session: `'connecting'` until `activateExternalSession` has
   * resolved, then `'connected'`; `'disconnected'` if an account switch
   * failed to re-establish it. Named for the chain because the only chain
   * this host serves unconditionally — the in-page loopback People store
   * that carries signing — is up exactly when the session is.
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
  /**
   * Clear chat state: rooms, bots and the message log. Live
   * `subscribeChatRooms` streams stay open and are pushed the now-empty
   * room list.
   */
  clearChatState(): void;
  /**
   * Inject an incoming chat action (e.g. a peer message) into the product.
   *
   * Published through the product's own runtime connection, which buffers it
   * until the product subscribes to its chat action stream. The promise
   * rejects if the action cannot be delivered — a payload the protocol codec
   * refuses, or a connection that cannot reach Chat — so await it.
   */
  injectChatAction(action: ChatActionInput): Promise<void>;
  /** List all preimages known to the test host (submitted by product + seeded by test). */
  getPreimages(): PreimageEntry[];
  /**
   * Seed the test host with a preimage value. The key is derived as
   * blake2b-256 of the value and returned. Any active `preimageLookup`
   * subscriptions for that key will be notified.
   */
  seedPreimage(value: Uint8Array): HexString;
  /** Clear all preimages. */
  clearPreimages(): void;
  /**
   * Get the current theme as the upstream struct
   * (`{ name: { tag, value }, variant }`). Use `theme.variant` for the
   * light/dark sub-mode (note the capitalization: `'Light' | 'Dark'`).
   */
  getTheme(): Theme;
  /**
   * Set the theme and notify subscribers.
   *
   * Accepts either a string shorthand (`'light' | 'dark'` — mapped to the
   * host's `Default` theme with the matching variant) or the full
   * `{ name, variant }` struct (e.g. to test product branches that read
   * `theme.name`).
   */
  setTheme(theme: ThemeInput): void;

  dispose(): void;
}
