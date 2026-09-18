/**
 * `window.__TEST_HOST__` — the surface Playwright drives the host from: the
 * readout over the state `host-runtime.ts`'s boot sequence produced.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { scale } from '@parity/truapi';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import type { IframeHost, WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import type { HostState } from './callbacks/index.js';
import type { SsoResponder } from './sso/responder.js';
import type {
  ChatActionInput,
  HexString,
  PermissionBehavior,
  TestHostAPI,
  Theme,
  ThemeInput,
} from '../types.js';

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

/** Re-`0x`-prefix a stored key without asserting its type. */
const asHex = (key: string): HexString => `0x${key.startsWith('0x') ? key.slice(2) : key}`;

function normalizeTheme(input: ThemeInput): Theme {
  if (input === 'light' || input === 'dark') {
    return { name: { tag: 'Default', value: undefined }, variant: input === 'light' ? 'Light' : 'Dark' };
  }
  return input;
}

export interface ControlApiOptions {
  state: HostState;
  /** A stable facade: account switching replaces the live responder underneath. */
  responder: SsoResponder;
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

    grantPermission(tag: string) {
      state.grantedPermissions.add(tag);
      if (DEVICE_PERMISSION_POLICY[tag]) refreshIframeAllow();
    },

    revokePermission(tag: string) {
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

    dispose() {
      options.disposeBridge();
      // Holds a loopback-store subscription: a disposed host must stop answering.
      responder.dispose();
      runtime.dispose();
      iframeHost.dispose();
    },
  };
}
