import type {
  AllocatableResource as CoreAllocatableResource,
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
  PermissionDecision as CorePermissionDecision,
  ProductExecutionKind as CoreProductExecutionKind,
} from '@parity/truapi-host';

/**
 * Wire-schema hash of the TrUAPI core this release bundles — what the host
 * actually speaks, as `wireSchemaHash()` reports it from the compiled core.
 *
 * A product connects only to a host on the same schema. The declared
 * `@parity/truapi` dependency is weaker evidence than this: the core ships as a
 * vendored `.wasm`, so the package version says what the JS codecs were built
 * against, not what the binary speaks.
 *
 * `build.mjs` reads the value out of the bundled `.wasm` and fails the build if
 * it disagrees with this constant, so it cannot go stale on a dependency bump.
 */
export const TRUAPI_WIRE_SCHEMA_HASH = '462dacb6e0d1f504';

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

/**
 * A consent answer and how long it lasts. `AllowOnce` is held in memory until
 * one permission-gated operation consumes it, so the next request prompts
 * again; `AllowAlways` and `Deny` are the lasting answers a real host persists.
 */
export type PermissionDecision = 'AllowOnce' | 'AllowAlways' | 'Deny';

/** Compile-time guard: this mirror must equal the core's decision enum. */
type _PermissionDecisionMirrorsCore = Expect<
  Equal<PermissionDecision, CorePermissionDecision>
>;

/** Which resource an `resourceAllocation.request` names, e.g. `'AutoSigning'`. */
export type AllocatableResourceTag =
  | 'StatementStoreAllowance'
  | 'BulletinAllowance'
  | 'SmartContractAllowance'
  | 'AutoSigning';

/** Compile-time guard: this mirror must equal the core's resource union. */
type _AllocatableResourceTagMirrorsCore = Expect<
  Equal<AllocatableResourceTag, CoreAllocatableResource['tag']>
>;

/**
 * Which resources the host allocates. `'approve-all'` is the default and what
 * every release before 0.15 did unconditionally.
 *
 * The record form grants anything it does not mention, so
 * `{ AutoSigning: false }` means "everything except auto-signing". It is the
 * only selective form that crosses `page.evaluate`, so it is what the Playwright
 * fixture and the `behaviors` boot option accept; the function form is in-page
 * only, like every other behavior here.
 */
export type ResourceAllocationBehavior =
  | 'approve-all'
  | 'reject-all'
  | Partial<Record<AllocatableResourceTag, boolean>>
  | ((resource: { tag: AllocatableResourceTag; productId: string }) => boolean);

/** One resource a product asked the host to allocate, and what it answered. */
export interface ResourceAllocationLogEntry {
  /** The product that asked, as its `callingProductId` named it. */
  productId: string;
  resource: AllocatableResourceTag;
  /** False means the host answered `Rejected`. */
  granted: boolean;
  timestamp: number;
}

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
  /**
   * Primary username `account.getUserId()` reports while this account is the
   * active identity (default: `"<name>.01"`, the shape of an attested lite
   * username). This host has no Asset Hub to resolve a real one from.
   */
  username?: string;
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
   * dotNS identifier the product runs as (default `'test-product.dot'`). The
   * core refuses every product-account signing call whose `dotNsIdentifier`
   * names a different product, so this must match what the product asks to
   * sign with.
   */
  productId?: string;
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

/**
 * One signing action the host was asked to perform.
 *
 * A product granted `AutoSigning` is signed for **inside the core**, which holds
 * the product's subtree secret from that moment on — no request reaches the host
 * and nothing lands here. A suite that asserts on signing must withhold that
 * resource: see `setResourceAllocationBehavior` and
 * `behaviors.resourceAllocation`.
 */
export interface SigningLogEntry {
  type: 'payload' | 'raw' | 'createTransaction';
  payload: unknown;
  timestamp: number;
}

export interface PermissionLogEntry {
  tag: string;
  value: unknown;
  /** `false` only for `'Deny'`: a one-use grant is still an approval. */
  approved: boolean;
  /** The answer's lifetime, as the core now records it. */
  decision: PermissionDecision;
  timestamp: number;
}

/**
 * One pending operation a `Worker` product opened to keep its runtime alive.
 * The core holds a worker reference for as long as the operation is open, so an
 * operation never ended is a product leaking its own runtime.
 */
export interface OperationEntry {
  /** Host-assigned id, unique among this product's open operations. */
  id: number;
  /** The product that opened it, as the core's `ProductContext` names it. */
  productId: string;
  /** Label for host logs and UI; empty when the product gave none. */
  label: string;
  startedAt: number;
  /** Epoch-ms when `endOperation` closed it; `undefined` while still open. */
  endedAt: number | undefined;
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

/**
 * One statement the loopback store holds — submitted by the product, or seeded
 * by a test with `injectStatement`. The host's own SSO signing traffic is not
 * in here: it never reaches the store's retained set.
 */
export interface StatementEntry {
  /** Topics the statement carries, `0x`-hex, in the order encoded. */
  topics: HexString[];
  /** The statement's payload, or `undefined` when it carries none. */
  data: HexString | undefined;
  /** The sr25519 proof, `0x`-hex, when the statement is signed. */
  proof: { signature: HexString; signer: HexString } | undefined;
  /** True when the product submitted it, false when a test injected it. */
  fromProduct: boolean;
  timestamp: number;
}

/** A statement to inject. Every field is optional but `topics`, which may be empty. */
export interface StatementInput {
  /** Up to four `0x`-hex topics. More throws, as the statement codec does. */
  topics: HexString[];
  /** `0x`-hex payload. */
  data?: HexString;
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
 * One product-storage entry, with the key split both ways.
 *
 * The core namespaces every key before the host sees it, so `key` — what
 * `getProductStorage()` is keyed by — carries an internal prefix. `localKey` is
 * the key the product itself passed to `localStorage.write`, which is what a
 * test actually knows.
 */
export interface ProductStorageEntry {
  /** The namespaced key, as the core handed it over. Pass this to `seedProductStorage`. */
  key: string;
  /**
   * The product's own key, parsed out of `key`. `undefined` when the prefix is
   * not the layout this version knows, so an upstream change surfaces as a
   * missing field rather than a wrong match.
   */
  localKey: string | undefined;
  /** The stored bytes, decoded as UTF-8. */
  value: string;
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
 * approves or refuses it, so a test can be selective without a matcher language.
 */
export type Behavior<Req> = 'approve-all' | 'reject-all' | ((request: Req) => boolean);

/** The one reading of a `Behavior`, so the named modes cannot drift between handlers. */
export function decideBehavior<Req>(behavior: Behavior<Req>, request: Req): boolean {
  if (behavior === 'approve-all') return true;
  if (behavior === 'reject-all') return false;
  return behavior(request);
}

/**
 * How the host answers a consent prompt whose answer carries a lifetime as well
 * as a verdict. `'approve-once'` returns the one-use grant the core holds only
 * until a permission-gated operation consumes it, so the product is prompted
 * again next time. The function form may answer with a bare boolean — `true`
 * reads as `'AllowAlways'`, `false` as `'Deny'` — or with the decision itself.
 */
export type DecisionBehavior<Req> =
  | 'approve-all'
  | 'approve-once'
  | 'reject-all'
  | ((request: Req) => boolean | PermissionDecision);

/** The one reading of a `DecisionBehavior`, mirroring `decideBehavior`. */
export function decideConsent<Req>(
  behavior: DecisionBehavior<Req>,
  request: Req,
): PermissionDecision {
  if (behavior === 'approve-all') return 'AllowAlways';
  if (behavior === 'approve-once') return 'AllowOnce';
  if (behavior === 'reject-all') return 'Deny';
  const answer = behavior(request);
  if (answer === true) return 'AllowAlways';
  if (answer === false) return 'Deny';
  return answer;
}

/**
 * How the test host answers remote permission requests; `'approve-all'` is the
 * default. A function returning `true` grants for good — return `'AllowOnce'`
 * to exercise the core's one-use grant.
 */
export type PermissionBehavior = DecisionBehavior<{ tag: string; value: unknown }>;

/** One review the host was asked to confirm, through either entry point. */
export interface UserConfirmationLogEntry {
  /** The review's variant tag, e.g. `SignRaw`. */
  tag: string;
  /** `false` only for `'Deny'`: a one-use grant is still an approval. */
  approved: boolean;
  /** The answer's lifetime. `confirmUserAction` can only ever yield a lasting one. */
  decision: PermissionDecision;
  /** True when the core asked through `confirmPermission` rather than `confirmUserAction`. */
  lifetimeAsked: boolean;
  timestamp: number;
}

/**
 * How the host answers `confirmUserAction` and `confirmPermission`;
 * `'approve-all'` is the default. `confirmUserAction` takes only the verdict, so
 * `'approve-once'` and a returned `'AllowOnce'` read as an approval there and
 * carry their lifetime only through `confirmPermission`.
 */
export type UserConfirmationBehavior = DecisionBehavior<{ tag: string; value: unknown }>;

/**
 * The one reading of a `ResourceAllocationBehavior`. A record grants anything
 * it does not mention, so the common case — withhold auto-signing, allow the
 * allowances a product needs to function — is one key.
 */
export function decideResource(
  behavior: ResourceAllocationBehavior,
  resource: { tag: AllocatableResourceTag; productId: string },
): boolean {
  if (behavior === 'approve-all') return true;
  if (behavior === 'reject-all') return false;
  if (typeof behavior === 'function') return behavior(resource);
  return behavior[resource.tag] ?? true;
}

const RESOURCE_TAGS: Record<AllocatableResourceTag, true> = {
  StatementStoreAllowance: true,
  BulletinAllowance: true,
  SmartContractAllowance: true,
  AutoSigning: true,
};

/**
 * Read a `behaviors.resourceAllocation` off the page config, which a plain-JS
 * caller can put anything on. A misspelled resource key would silently grant
 * the resource it was meant to withhold — which is the exact bug this option
 * exists to fix — so an unknown key throws rather than being ignored.
 */
export function parseResourceAllocationBehavior(value: unknown): ResourceAllocationBehavior {
  if (value === 'approve-all' || value === 'reject-all') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid resourceAllocation behavior: ${JSON.stringify(value)}`);
  }
  const record: Partial<Record<AllocatableResourceTag, boolean>> = {};
  for (const [key, granted] of Object.entries(value)) {
    if (!Object.hasOwn(RESOURCE_TAGS, key)) {
      throw new Error(`invalid resourceAllocation resource: "${key}"`);
    }
    if (typeof granted !== 'boolean') {
      throw new Error(`resourceAllocation."${key}" must be a boolean`);
    }
    record[key as AllocatableResourceTag] = granted;
  }
  return record;
}

/** How the host answers `navigateTo`; `'approve-all'` is the default. */
export type NavigationBehavior = Behavior<{ url: string }>;

/** How the host answers `pushNotification`; `'approve-all'` is the default. */
export type NotificationBehavior = Behavior<{
  text: string;
  deeplink: string | undefined;
  /** Future delivery time in epoch-ms, or undefined for immediate. */
  scheduledAt: bigint | undefined;
}>;

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
  permission?: 'approve-all' | 'approve-once' | 'reject-all';
  userConfirmation?: 'approve-all' | 'approve-once' | 'reject-all';
  navigation?: 'approve-all' | 'reject-all';
  notification?: 'approve-all' | 'reject-all';
  /**
   * Which resources the host allocates. Takes the record form as well as the
   * two named modes, because withholding `AutoSigning` has to be settable
   * before the product's first frame — a product that asks for it at boot has
   * already been granted it by the time a setter could run.
   */
  resourceAllocation?:
    | 'approve-all'
    | 'reject-all'
    | Partial<Record<AllocatableResourceTag, boolean>>;
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
  /**
   * Pre-grant a permission without the product requesting it, in the core as
   * well as in the host's own view — the core is what actually gates the
   * product. Awaitable: the core write is a round trip to the worker.
   *
   * `value` is the permission's payload, needed only by the variants that carry
   * one. `Remote` is the only such permission today, and the domains are part of
   * what the core stores the decision under:
   * `grantPermission('Remote', { domains: ['example.dot'] })`. Rejects on an
   * unknown tag, or on a payload-carrying one given without its payload, rather
   * than writing an authorization the core will never match.
   */
  grantPermission(tag: string, value?: unknown): Promise<void>;
  /**
   * Revoke a permission, returning the product to being asked the next time it
   * needs one. Combine with `setPermissionBehavior('reject-all')` to make that
   * asking end in a refusal.
   *
   * Takes `value` on the same terms as `grantPermission`, and must be given the
   * same payload the grant used — it addresses one stored decision, not a tag.
   *
   * Before 0.15 this touched only the host's own set, so `getGrantedPermissions()`
   * changed while the core kept the decision it had stored and went on serving
   * the product without asking again.
   */
  revokePermission(tag: string, value?: unknown): Promise<void>;
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

  /**
   * Every statement the loopback store holds, oldest first: what the product
   * submitted, plus anything `injectStatement` seeded. The host's own SSO
   * signing traffic is excluded — use `getSigningLog()` for that.
   */
  getStatements(): StatementEntry[];
  /**
   * Statements the PRODUCT submitted, in order — `getStatements()` narrowed to
   * `fromProduct`. The oracle for "did the product publish what it should".
   */
  getSubmittedStatements(): StatementEntry[];
  /**
   * Seed a statement: retained like a submission, delivered at once to every
   * live subscription whose topic filter matches, and replayed to one opened
   * later. Returns the entry as `getStatements()` reports it.
   */
  injectStatement(statement: StatementInput): StatementEntry;
  /**
   * Drop every retained statement. Live subscriptions stay open and keep
   * receiving; a subscription opened afterwards starts from empty. Signing is
   * unaffected — the SSO channel is not in the retained set.
   */
  clearStatements(): void;
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
  /**
   * Every product-storage entry, decoded as UTF-8, keyed by the NAMESPACED key
   * the core handed the host — `truapi:product-storage:v1:<n>:<productId>:<key>`.
   * Prefer `getProductStorageEntries()` or `getProductStorageValue()` when a
   * test knows the product's own key: matching this map's keys by suffix is
   * ambiguous when a local key contains `:`.
   */
  getProductStorage(): Record<string, string>;
  /**
   * Every entry with its key split both ways, so a test can match on the
   * product's own key without hand-parsing the namespace.
   */
  getProductStorageEntries(): ProductStorageEntry[];
  /**
   * The value the product stored under `localKey`, or `undefined` if it stored
   * none. An exact match on the parsed key, not a suffix match.
   */
  getProductStorageValue(localKey: string): string | undefined;
  /** Drop every product-storage entry. Live `subscribeStorage` streams are pushed the clear. */
  clearProductStorage(): void;

  /**
   * Every pending operation a `Worker` product opened, in the order opened —
   * still-open ones and those already ended.
   */
  getOperationLog(): OperationEntry[];
  /** Just the operations still open: what is holding the product's worker runtime up. */
  getOpenOperations(): OperationEntry[];
  /** Drop the log. Operations still open stay open and can still be ended. */
  clearOperationLog(): void;

  /**
   * Choose which resources the host allocates. Withholding `AutoSigning` is
   * what makes signing observable: see `getSigningLog()`.
   */
  setResourceAllocationBehavior(behavior: ResourceAllocationBehavior): void;
  /** Every resource a product asked for, and whether the host allocated it. */
  getResourceAllocationLog(): ResourceAllocationLogEntry[];
  /** Drop the resource-allocation log. */
  clearResourceAllocationLog(): void;

  dispose(): void;
}
