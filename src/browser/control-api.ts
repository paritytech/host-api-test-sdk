/**
 * `window.__TEST_HOST__` — the surface Playwright drives the host from.
 *
 * Every member is a port of the pre-migration control API in
 * `host-runtime.ts`: same names, same return shapes, same observable
 * behaviour, so existing consumers do not have to change. What moved is
 * where the state lives — `HostState` for the callback groups, the SSO
 * responder for the signing log, and the product provider for the one
 * control (`injectChatAction`) that pushes *into* the product rather than
 * reading something out of the host.
 *
 * It is a separate module from `host-runtime.ts` because the runtime's job
 * is the boot sequence; this is the readout over the state that sequence
 * produced.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import type { HostChatActionSubscribeItem } from '@parity/truapi';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import type { IframeHost, WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import type { HostState } from './callbacks/index.js';
import type { SsoResponder } from './sso/responder.js';
import type { HexString, PermissionBehavior, TestHostAPI, Theme, ThemeInput } from '../types.js';

/**
 * Host permission names mapped to the Permissions Policy directives that
 * belong in the product iframe's `allow` attribute. Matches dot.li's own
 * mapping, and is the reason `grantPermission` touches the iframe at all.
 */
export const DEVICE_PERMISSION_POLICY: Record<string, string> = {
  Camera: 'camera',
  Microphone: 'microphone',
  Location: 'geolocation',
  Bluetooth: 'bluetooth',
  NFC: 'nfc',
  Clipboard: 'clipboard-read',
  Biometrics: 'publickey-credentials-get',
};

/**
 * Build the iframe `allow` attribute for the currently granted permissions.
 * Clipboard access is always present, as it was pre-migration.
 */
export function buildAllowAttribute(granted: Iterable<string>): string {
  const policies = ['clipboard-read', 'clipboard-write'];
  for (const tag of granted) {
    const directive = DEVICE_PERMISSION_POLICY[tag];
    if (directive) policies.push(directive);
  }
  return policies.join('; ');
}

const toHex = (bytes: Uint8Array): HexString =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

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
  /**
   * The SSO responder that answers signing requests. Account switching
   * replaces the live responder, so `host-runtime.ts` passes a stable facade
   * that forwards to whichever one is current.
   */
  responder: SsoResponder;
  runtime: WorkerPairingHostRuntime;
  iframeHost: IframeHost;
  /** The live product provider. Re-created when accounts switch. */
  provider(): TrUApiProductProvider;
  /**
   * Re-mint the session for these dev accounts, re-activate it, and
   * re-create the product provider. Resolves once routing has resumed.
   */
  setAccounts(names: string[]): Promise<void>;
  /** `'connected'` once `activateExternalSession` has resolved. */
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
      // The only chain this host serves unconditionally is the in-page
      // loopback People store, which is up as soon as the session is.
      return options.connectionStatus();
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

    setEnforcePermissions(_enforce: boolean) {
      // Signing is not gated here: it leaves for the paired wallet over the
      // SSO channel, and the core enforces `ChainSubmit` itself at
      // `transaction_broadcast`. Kept so existing tests keep working.
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

    clearChatState() {
      state.chatRooms.clear();
      state.chatBots.clear();
      state.chatMessageLog.length = 0;
      state.nextChatMessageId = 1;
      // Subscribers are deliberately kept: they are the core's own live
      // `subscribeChatRooms` streams, and dropping them would silently stop
      // a product from ever seeing another room. Push the empty list instead.
      for (const notify of state.chatRoomSubscribers) notify([]);
    },

    injectChatAction(action: HostChatActionSubscribeItem) {
      // Not a callback-group read: an inbound chat action goes out through
      // the product's own runtime connection, which buffers it until the
      // product subscribes. Optional on the provider, hence the guard.
      const published = provider().publishChatAction?.(action);
      published?.catch((error: unknown) => {
        console.error('[test-host] injectChatAction failed:', error);
      });
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
      const key = toHex(blake2b(value, { dkLen: 32 }));
      const lookupKey = key.toLowerCase();
      state.preimages.set(lookupKey, {
        key: lookupKey,
        value,
        fromProduct: false,
        timestamp: Date.now(),
      });
      const subscribers = state.preimageSubscribers.get(lookupKey);
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
      // `HostState`'s `value` is optional on the `Default` arm; the public
      // `Theme` spells it out, so normalise rather than assert.
      return { name: name.tag === 'Default' ? { tag: 'Default', value: undefined } : name, variant };
    },

    setTheme(theme: ThemeInput) {
      state.theme = normalizeTheme(theme);
      for (const notify of state.themeSubscribers) notify(state.theme);
    },

    dispose() {
      options.disposeBridge();
      // The responder holds a subscription on the loopback store; dropping it
      // here keeps a disposed host from answering statements.
      responder.dispose();
      runtime.dispose();
      iframeHost.dispose();
    },
  };
}
