/**
 * `window.__TEST_HOST__` — the surface Playwright drives the host from: the
 * readout over the state `host-runtime.ts`'s boot sequence produced.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { scale } from '@parity/truapi';
import type { RemotePermissionRequest } from '@parity/truapi';
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
  TrUApiProductProvider,
} from '@parity/truapi-host';
import type { IframeHost, WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import type { ChainRuntimeConfig } from './callbacks/chain.js';
import { roomListSnapshot } from './callbacks/chat.js';
import { derivedChains } from './callbacks/features.js';
import {
  clearAllProductStorage,
  parseProductStorageKey,
  setProductStorage,
} from './callbacks/storage.js';
import type { HostState } from './callbacks/index.js';
import type { LoopbackStore, StoredStatement } from './loopback-chain.js';
import type { SsoResponder } from './sso/responder.js';
import { encodeStatement, signStatement } from './sso/statement.js';
import type { Statement } from './sso/statement.js';
import { parseResourceAllocationBehavior } from '../types.js';
import type {
  ChainEntry,
  ChatActionInput,
  ChatBot,
  ChatRoom,
  DevicePermissionStatus,
  HexString,
  HostDevicePermissionRequest,
  NavigationBehavior,
  NotificationBehavior,
  PermissionBehavior,
  ProductStorageEntry,
  ResourceAllocationBehavior,
  StatementEntry,
  StatementInput,
  TestHostAPI,
  Theme,
  ThemeInput,
  UserConfirmationBehavior,
} from '../types.js';

/**
 * The device capabilities, as `HostDevicePermissionRequest` names them. A tag
 * outside this set is a `RemotePermission` — the split the core's
 * `PermissionAuthorizationRequest` needs, which a bare tag string does not carry.
 *
 * Written as a total record rather than a `Set<string>` so the compiler keeps it
 * in step with the core: a device capability added upstream fails to compile
 * here instead of being quietly routed as a remote permission, which would
 * write the authorization under a key the core never reads.
 */
const DEVICE_PERMISSIONS: Record<HostDevicePermissionRequest, true> = {
  Notifications: true,
  Camera: true,
  Microphone: true,
  Bluetooth: true,
  NFC: true,
  Location: true,
  Clipboard: true,
  OpenUrl: true,
  Biometrics: true,
};

type RemotePermission = RemotePermissionRequest['permission'];

/**
 * The remote permissions, and whether the variant carries a payload. `Remote`
 * does — the domain list is part of what the core stores the decision under —
 * so a grant naming it without one cannot be expressed and is rejected rather
 * than written wrong.
 */
const REMOTE_PERMISSIONS: Record<RemotePermission['tag'], boolean> = {
  Remote: true,
  WebRtc: false,
  ChainSubmit: false,
  PreimageSubmit: false,
  StatementSubmit: false,
};

export function toAuthorizationRequest(
  tag: string,
  value: unknown,
): PermissionAuthorizationRequest {
  if (Object.hasOwn(DEVICE_PERMISSIONS, tag)) {
    return { tag: 'Device', value: tag as HostDevicePermissionRequest };
  }
  if (!Object.hasOwn(REMOTE_PERMISSIONS, tag)) {
    throw new Error(
      `unknown permission "${tag}": expected one of ${[
        ...Object.keys(DEVICE_PERMISSIONS),
        ...Object.keys(REMOTE_PERMISSIONS),
      ].join(', ')}`,
    );
  }
  if (REMOTE_PERMISSIONS[tag as RemotePermission['tag']] && value === undefined) {
    throw new Error(
      `permission "${tag}" carries a payload and cannot be granted by tag alone — ` +
        `pass it, e.g. grantPermission('Remote', { domains: ['example.dot'] })`,
    );
  }
  return { tag: 'Remote', value: { permission: { tag, value } as RemotePermission } };
}

/** Matches dot.li's own mapping, and is why `grantPermission` touches the iframe. */
export const DEVICE_PERMISSION_POLICY: Record<string, string> = {
  Camera: 'camera',
  Microphone: 'microphone',
  Location: 'geolocation',
  Bluetooth: 'bluetooth',
  NFC: 'nfc',
  Clipboard: 'clipboard-read',
  Biometrics: 'publickey-credentials-get',
};

/** Clipboard access is unconditional; everything else follows the grants. */
export function buildAllowAttribute(granted: Iterable<string>): string {
  const policies = ['clipboard-read', 'clipboard-write'];
  for (const tag of granted) {
    const directive = DEVICE_PERMISSION_POLICY[tag];
    if (directive) policies.push(directive);
  }
  return policies.join('; ');
}

/** The store keeps bytes; the control API reports the `0x`-hex a test asserts on. */
function toStatementEntry(entry: StoredStatement): StatementEntry {
  const { statement } = entry;
  return {
    topics: (statement.topics ?? []).map((topic) => scale.bytesToHex(topic)),
    data: statement.data === undefined ? undefined : scale.bytesToHex(statement.data),
    proof: statement.proof && {
      signature: scale.bytesToHex(statement.proof.signature),
      signer: scale.bytesToHex(statement.proof.signer),
    },
    fromProduct: entry.fromProduct,
    timestamp: entry.timestamp,
  };
}

/** Re-`0x`-prefix a stored key without asserting its type. */
const asHex = (key: string): HexString => `0x${key.startsWith('0x') ? key.slice(2) : key}`;

export function normalizeTheme(input: ThemeInput): Theme {
  if (input === 'light' || input === 'dark') {
    return { name: { tag: 'Default', value: undefined }, variant: input === 'light' ? 'Light' : 'Dark' };
  }
  return input;
}

export interface ControlApiOptions {
  state: HostState;
  /** The configured networks, so `getSupportedChains()` can report the derived set. */
  networks: readonly ChainRuntimeConfig[];
  /** A stable facade: account switching replaces the live responder underneath. */
  responder: SsoResponder;
  /** The in-page People store, for the statement controls. */
  store: LoopbackStore;
  /** The dotNS id the product runs as — the namespace the core stores decisions under. */
  productId: string;
  /**
   * The active session's 64-byte sr25519 identity secret. Read through a
   * callback because an account switch re-mints it, and an injected statement
   * must be signed by whoever the host currently is.
   */
  identitySecret(): Uint8Array;
  runtime: WorkerPairingHostRuntime;
  iframeHost: IframeHost;
  /** The live product provider. Re-created when accounts switch. */
  provider(): TrUApiProductProvider;
  /** Re-mint and re-activate the session; resolves once routing has resumed. */
  setAccounts(names: string[]): Promise<void>;
  /** The PRODUCT connection — `'connected'` only once a frame has crossed the bridge. */
  connectionStatus(): string;
  /** Tear down the MessagePort ↔ provider bridge. */
  disposeBridge(): void;
}

export function buildControlApi(options: ControlApiOptions): TestHostAPI {
  const { state, responder, runtime, iframeHost, provider } = options;

  /**
   * Write the decision the core acts on. Failures reject rather than warn: a
   * write that does not land leaves `getGrantedPermissions()` describing a
   * state the core will not honour, which is the exact silent wrongness these
   * two calls were changed to stop.
   */
  const setAuthorization = async (
    tag: string,
    value: unknown,
    status: PermissionAuthorizationStatus,
  ) => {
    await runtime.setPermissionAuthorizationStatus(
      options.productId,
      toAuthorizationRequest(tag, value),
      status,
    );
  };

  /** Re-apply the Permissions Policy for whatever is granted right now. */
  const refreshIframeAllow = () => {
    iframeHost.iframe.allow = buildAllowAttribute(state.grantedPermissions);
  };

  return {
    async switchAccount(name: string): Promise<void> {
      await options.setAccounts([name]);
    },

    async setAccounts(names: string[]): Promise<void> {
      await options.setAccounts(names);
    },

    getSigningLog() {
      return responder.getSigningLog();
    },

    clearSigningLog() {
      responder.clearSigningLog();
    },

    getConnectionStatus() {
      return options.connectionStatus();
    },

    getChainStatus() {
      // The core's own report; silence before the first one is activation
      // still in flight.
      if (!state.authState) return 'connecting';
      return state.authState.tag === 'Connected' ? 'connected' : 'disconnected';
    },

    setPermissionBehavior(behavior: PermissionBehavior) {
      state.permissionBehavior = behavior;
    },

    async grantPermission(tag: string, value?: unknown) {
      // The core keeps its own decision, and that is the one it acts on. The
      // host's set only drives `getGrantedPermissions()` and the iframe policy,
      // so writing one without the other reports a state the core will not
      // honour — which is why the core goes first and a failure leaves neither.
      await setAuthorization(tag, value, 'Authorized');
      state.grantedPermissions.add(tag);
      if (DEVICE_PERMISSION_POLICY[tag]) refreshIframeAllow();
    },

    async revokePermission(tag: string, value?: unknown) {
      // `NotDetermined`, not `Denied`: revoking returns the product to being
      // asked, which is what a test revoking before a reconnect is after. Use
      // `setPermissionBehavior('reject-all')` to make that asking end in refusal.
      await setAuthorization(tag, value, 'NotDetermined');
      state.grantedPermissions.delete(tag);
      if (DEVICE_PERMISSION_POLICY[tag]) refreshIframeAllow();
    },

    getGrantedPermissions() {
      return [...state.grantedPermissions];
    },

    getPermissionLog() {
      return [...state.permissionLog];
    },

    clearPermissionLog() {
      state.permissionLog.length = 0;
    },

    setDevicePermissionStatus(
      type: HostDevicePermissionRequest,
      status: DevicePermissionStatus | undefined,
    ) {
      if (status === undefined) state.devicePermissionStatuses.delete(type);
      else state.devicePermissionStatuses.set(type, status);
    },

    getDevicePermissionStatuses() {
      return Object.fromEntries(state.devicePermissionStatuses);
    },

    getNavigationLog() {
      return [...state.navigationLog];
    },

    clearNavigationLog() {
      state.navigationLog.length = 0;
    },

    getNotificationLog() {
      return [...state.notificationLog];
    },

    clearNotificationLog() {
      state.notificationLog.length = 0;
    },

    getChatRooms() {
      return [...state.chatRooms.values()];
    },

    getChatBots() {
      return [...state.chatBots.values()];
    },

    getChatMessageLog() {
      return [...state.chatMessageLog];
    },

    clearChat() {
      state.chatRooms.clear();
      state.chatBots.clear();
      state.chatMessageLog.length = 0;
      state.nextChatMessageId = 1;
      // Subscribers are kept: they are the core's live `subscribeChatRooms`
      // streams, and dropping one stops that product seeing another room.
      for (const notify of state.chatRoomSubscribers) notify([]);
    },

    seedChatRoom(room: ChatRoom) {
      state.chatRooms.set(room.roomId, room);
      const snapshot = roomListSnapshot(state);
      for (const notify of state.chatRoomSubscribers) notify(snapshot);
    },

    seedChatBot(bot: ChatBot) {
      state.chatBots.set(bot.botId, bot);
    },

    injectChatAction(action: ChatActionInput): Promise<void> {
      // Goes out over the product's own runtime connection, which buffers it
      // until the product subscribes. The promise is returned, not swallowed,
      // so a rejected payload fails the caller's `await`.
      const live = provider();
      if (!live.publishChatAction) {
        return Promise.reject(new Error('this product connection cannot publish chat actions'));
      }
      return live.publishChatAction(action);
    },

    getPreimages() {
      return [...state.preimages.values()].map((entry) => ({
        key: asHex(entry.key),
        value: entry.value,
        fromProduct: entry.fromProduct,
        timestamp: entry.timestamp,
      }));
    },

    seedPreimage(value: Uint8Array): HexString {
      const key = scale.bytesToHex(blake2b(value, { dkLen: 32 }));
      state.preimages.set(key, {
        key,
        value,
        fromProduct: false,
        timestamp: Date.now(),
      });
      const subscribers = state.preimageSubscribers.get(key);
      if (subscribers) {
        for (const notify of subscribers) notify(value);
      }
      return key;
    },

    clearPreimages() {
      state.preimages.clear();
    },

    getStatements(): StatementEntry[] {
      return options.store.statements().map(toStatementEntry);
    },

    getSubmittedStatements(): StatementEntry[] {
      return options.store
        .statements()
        .filter((entry) => entry.fromProduct)
        .map(toStatementEntry);
    },

    injectStatement(input: StatementInput): StatementEntry {
      const unsigned: Statement = {
        topics: input.topics.map((topic) => scale.hexToBytes(topic)),
        data: input.data === undefined ? undefined : scale.hexToBytes(input.data),
      };
      // Encoding first: the codec caps topics at four, and a throw here names
      // the problem rather than leaving a statement half-delivered.
      encodeStatement(unsigned);
      // The core drops an unproven statement on the floor — silently, since a
      // store is allowed to serve anything — so an injected one is signed by
      // the session identity, exactly as the SSO responder signs its replies.
      const statement = signStatement(options.identitySecret(), unsigned);
      options.store.inject(statement);
      const stored = options.store.statements();
      return toStatementEntry(stored[stored.length - 1]);
    },

    clearStatements() {
      options.store.clear();
    },

    getTheme(): Theme {
      const { name, variant } = state.theme;
      // `HostState` leaves `value` optional on `Default`; the public `Theme`
      // spells it out.
      return { name: name.tag === 'Default' ? { tag: 'Default', value: undefined } : name, variant };
    },

    setTheme(theme: ThemeInput) {
      state.theme = normalizeTheme(theme);
      for (const notify of state.themeSubscribers) notify(state.theme);
    },

    getLocale() {
      return state.locale;
    },

    setLocale(languageTag: string) {
      state.locale = languageTag;
      for (const notify of state.localeSubscribers) notify(state.locale);
    },

    setUserConfirmationBehavior(behavior: UserConfirmationBehavior) {
      state.userConfirmationBehavior = behavior;
    },

    getUserConfirmationLog() {
      return [...state.userConfirmationLog];
    },

    clearUserConfirmationLog() {
      state.userConfirmationLog.length = 0;
    },

    setNavigationBehavior(behavior: NavigationBehavior) {
      state.navigationBehavior = behavior;
    },

    setNotificationBehavior(behavior: NotificationBehavior) {
      state.notificationBehavior = behavior;
    },

    setFeatureSupport(feature: string, supported: boolean | undefined) {
      if (supported === undefined) state.featureOverrides.delete(feature);
      else state.featureOverrides.set(feature, supported);
    },

    getFeatureSupport() {
      return Object.fromEntries(state.featureOverrides);
    },

    setSupportedChains(chains: ChainEntry[] | undefined) {
      state.supportedChainsOverride = chains;
    },

    getSupportedChains(): ChainEntry[] {
      return state.supportedChainsOverride ?? derivedChains(options.networks);
    },

    seedProductStorage(key: string, value: string) {
      setProductStorage(state, key, new TextEncoder().encode(value));
    },

    getProductStorage() {
      const out: Record<string, string> = {};
      for (const [key, value] of state.productStorage) out[key] = new TextDecoder().decode(value);
      return out;
    },

    getProductStorageEntries(): ProductStorageEntry[] {
      return [...state.productStorage].map(([key, value]) => ({
        key,
        localKey: parseProductStorageKey(key)?.localKey,
        value: new TextDecoder().decode(value),
      }));
    },

    getProductStorageValue(localKey: string): string | undefined {
      for (const [key, value] of state.productStorage) {
        if (parseProductStorageKey(key)?.localKey !== localKey) continue;
        return new TextDecoder().decode(value);
      }
      return undefined;
    },

    clearProductStorage() {
      clearAllProductStorage(state);
    },

    getOperationLog() {
      return state.operationLog.map((entry) => ({ ...entry }));
    },

    getOpenOperations() {
      return [...state.openOperations.values()].map((entry) => ({ ...entry }));
    },

    setResourceAllocationBehavior(behavior: ResourceAllocationBehavior) {
      // Validated on the way in, exactly as `behaviors.resourceAllocation` is:
      // this is reachable from plain JS through `page.evaluate`, where a
      // misspelled resource key would silently grant the one it meant to
      // withhold. The function form is in-page only and passes through.
      state.resourceAllocationBehavior =
        typeof behavior === 'function' ? behavior : parseResourceAllocationBehavior(behavior);
    },

    getResourceAllocationLog() {
      return [...state.resourceAllocationLog];
    },

    clearResourceAllocationLog() {
      state.resourceAllocationLog.length = 0;
    },

    clearOperationLog() {
      // The open map keeps its entries, so an operation opened before the clear
      // can still be ended — it just no longer shows in the log.
      state.operationLog.length = 0;
    },

    dispose() {
      options.disposeBridge();
      // Holds a loopback-store subscription: a disposed host must stop answering.
      responder.dispose();
      runtime.dispose();
      iframeHost.dispose();
    },
  };
}
