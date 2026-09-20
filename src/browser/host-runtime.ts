/**
 * Browser-side host runtime — the boot sequence for the in-page TrUAPI host.
 *
 * Boot order in `init` is load-bearing: each step is the next one's input.
 * Nothing leaves the page — this host mints BOTH halves of the SSO session
 * because there is no wallet and no network here, so it also plays the peer.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { createMessagePortProvider } from '@parity/truapi';
import type { WireProvider } from '@parity/truapi';
import type {
  ProductExecutionKind,
  RequiredHostCallbacks,
  TrUApiProductProvider,
} from '@parity/truapi-host';
import type { IframeHost } from '@parity/truapi-host/web';
import { createIframeHost, createWebWorkerPairingHostRuntime } from '@parity/truapi-host/web';

import { buildAllowAttribute, buildControlApi, normalizeTheme } from './control-api.js';
import type { ChainRuntimeConfig, HostState } from './callbacks/index.js';
import { createHostCallbacks, createHostState } from './callbacks/index.js';
import { genesisForRole } from './callbacks/features.js';
import { PEOPLE_GENESIS_HASH } from './constants.js';
import type { DevKeypair } from './dev-accounts.js';
import { deriveDev, deriveFromUri } from './dev-accounts.js';
import { createHostWorker } from './host-worker.js';
import { createLoopbackStore } from './loopback-chain.js';
import { resolveProductAccount } from './product-accounts.js';
import type { ResponderSession, SigningLogEntry, SsoResponder } from './sso/responder.js';
import { createSsoResponder } from './sso/responder.js';
import type { ResolveAccount } from './sso/ring-vrf.js';
import { encodeExternalPairedSession } from './sso/session-blob.js';
import type { DevicePermissionStatus, InitialBehaviors, InitialState, TestHostAPI } from '../types.js';

interface AccountConfig {
  name: string;
  uri: string;
  /** Absent means `defaultUsername(name)`. */
  username?: string;
}

interface HostConfig {
  productUrl: string;
  /** dotNS identifier the product runs as. */
  productId?: string;
  /** Absent means `DEFAULT_EXECUTION_KIND`. */
  executionKind?: ProductExecutionKind;
  accounts: AccountConfig[];
  /** Networks the host can route, matched by genesis. First is the default. */
  networks: ChainRuntimeConfig[];
  /** Maps a bare dotNS product id → { name, uri } for subtree overrides. */
  productAccounts?: Record<string, AccountConfig>;
  /** Host state applied before `createIframeHost` runs, so the product's first frame already sees it. */
  initialState?: InitialState;
  behaviors?: InitialBehaviors;
}

// A `Record` over the union rather than a restated array: if `DevicePermissionStatus`
// gains a member upstream, this fails to compile instead of silently rejecting
// a now-valid status at runtime.
const DEVICE_PERMISSION_STATUSES: Record<DevicePermissionStatus, true> = {
  Granted: true,
  Denied: true,
  NotDetermined: true,
  NotApplicable: true,
};

/**
 * The page config crosses a JSON boundary a plain-JS caller can put anything
 * on, so this is checked at runtime even though `InitialState` already types
 * the field — a bad value must throw rather than silently misreport.
 */
function toDevicePermissionStatus(value: string): DevicePermissionStatus {
  if (Object.hasOwn(DEVICE_PERMISSION_STATUSES, value)) {
    return value as DevicePermissionStatus;
  }
  throw new Error(`invalid device permission status: "${value}"`);
}

/** Read off the published type, so a mode added there fails to compile here. */
type BehaviorMode = NonNullable<InitialBehaviors['permission']>;

const BEHAVIOR_MODES: Record<BehaviorMode, true> = { 'approve-all': true, 'reject-all': true };

/** Same JSON boundary: an accepted typo would surface much later, as a call to a non-function. */
function toBehaviorMode(name: string, value: string): BehaviorMode {
  if (Object.hasOwn(BEHAVIOR_MODES, value)) {
    return value as BehaviorMode;
  }
  throw new Error(`invalid ${name} behavior: "${value}"`);
}

/** Apply the page config's overrides before the product can observe anything. */
function applyInitialConfig(state: HostState, config: HostConfig): void {
  const initial = config.initialState;
  if (initial?.theme) state.theme = normalizeTheme(initial.theme);
  if (initial?.locale) state.locale = initial.locale;
  for (const [feature, supported] of Object.entries(initial?.features ?? {})) {
    state.featureOverrides.set(feature, supported);
  }
  for (const [key, value] of Object.entries(initial?.productStorage ?? {})) {
    state.productStorage.set(key, new TextEncoder().encode(value));
  }
  for (const [type, status] of Object.entries(initial?.devicePermissionStatuses ?? {})) {
    state.devicePermissionStatuses.set(type, toDevicePermissionStatus(status));
  }
  if (initial?.supportedChains) state.supportedChainsOverride = initial.supportedChains;
  for (const tag of initial?.grantedPermissions ?? []) state.grantedPermissions.add(tag);

  const behaviors = config.behaviors;
  if (behaviors?.permission) {
    state.permissionBehavior = toBehaviorMode('permission', behaviors.permission);
  }
  if (behaviors?.userConfirmation) {
    state.userConfirmationBehavior = toBehaviorMode('userConfirmation', behaviors.userConfirmation);
  }
  if (behaviors?.navigation) {
    state.navigationBehavior = toBehaviorMode('navigation', behaviors.navigation);
  }
  if (behaviors?.notification) {
    state.notificationBehavior = toBehaviorMode('notification', behaviors.notification);
  }
}

declare global {
  interface Window {
    __TEST_HOST_CONFIG__: HostConfig;
    __TEST_HOST__: TestHostAPI;
  }
}

const PRODUCT_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

const DEFAULT_PRODUCT_ID = 'test-product.dot';

/**
 * `App` is the core's own default and the truth for an iframe-embedded product.
 * Chat needs `'Worker'` (`runtime/chat.rs`), but a test asks for that
 * explicitly rather than every product being declared headless.
 */
const DEFAULT_EXECUTION_KIND: ProductExecutionKind = 'App';

const encoder = new TextEncoder();

/**
 * Mint both halves of an SSO session for one signer. A real paired host holds
 * only its own half and the peer's public key; this page is also the peer, so
 * it keeps `peerEncSecret`. `identitySecret` is the key every application reply
 * must be signed by, which the responder verifies at construction.
 *
 * The username is minted here too: the core only ever resolves one from the
 * dotNS contracts on Asset Hub, so a host without a reachable one has to supply
 * it or `account.getUserId` has nothing to answer.
 */
function mintSession(signer: DevKeypair, username: string): ResponderSession {
  const statementStore = deriveDev('Alice', 'statement-store');
  const peerEncSecret = x25519.utils.randomSecretKey();
  return {
    rootPublicKey: signer.publicKey,
    identityAccountId: signer.publicKey,
    identitySecret: signer.secretKey,
    // Per-signer and non-zero: an all-zero source would give two accounts the
    // same product entropy.
    rootEntropySource: blake2b(concat(signer.publicKey, encoder.encode('root-entropy')), { dkLen: 32 }),
    encSecret: x25519.utils.randomSecretKey(),
    peerEncPubkey: x25519.getPublicKey(peerEncSecret),
    peerEncSecret,
    ssSecret: statementStore.secretKey,
    ssPublicKey: statementStore.publicKey,
    sessionIdOwn: crypto.getRandomValues(new Uint8Array(32)),
    sessionIdPeer: crypto.getRandomValues(new Uint8Array(32)),
    username,
  };
}

/**
 * The shape a real attested lite username has — `alice.01` — so a product that
 * parses or renders one is not being shown something no live host would emit.
 */
function defaultUsername(accountName: string): string {
  return `${accountName.toLowerCase()}.01`;
}

/** The session identity's username, for whichever account is active. */
const usernameOf = (account: AccountConfig): string =>
  account.username ?? defaultUsername(account.name);

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * The configured roster wins so that a custom `{ name, uri }` keeps its URI —
 * deriving `//Custom` from a display name would silently sign with a key nobody
 * asked for. The roster passed in is always the BOOT config, never the accounts
 * in force, so a switch away from a custom account can be switched back.
 */
function resolveAccountName(roster: readonly AccountConfig[], name: string): AccountConfig {
  const wanted = name.toLowerCase();
  const configured = roster.find((account) => account.name.toLowerCase() === wanted);
  if (configured) return configured;
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return { name: capitalized, uri: `//${capitalized}` };
}

/**
 * Two-way pipe between two wire providers. Both carry the same SCALE frames, so
 * a plain relay is the whole bridge. `onFrameFromLeft` is how product
 * connection status is observed — the first frame off the port is the product.
 */
function bridgeProviders(
  left: WireProvider,
  right: WireProvider,
  onFrameFromLeft?: () => void,
): () => void {
  const stopLeft = left.subscribe((frame) => {
    onFrameFromLeft?.();
    right.postMessage(frame);
  });
  const stopRight = right.subscribe((frame) => left.postMessage(frame));
  return () => {
    stopLeft();
    stopRight();
  };
}

/**
 * Re-apply the iframe's Permissions Policy when a device permission is answered.
 *
 * A Permissions Policy only takes effect at navigation, and nothing here
 * re-navigates the iframe (see `setAccounts`), so this writes the attribute for
 * a future load rather than changing the document already running.
 */
function withIframePermissionsPolicy(
  callbacks: RequiredHostCallbacks,
  state: HostState,
  iframe: () => HTMLIFrameElement | undefined,
): RequiredHostCallbacks {
  const { devicePermission, ...rest } = callbacks.permissions;
  return {
    ...callbacks,
    permissions: {
      ...rest,
      async devicePermission(request) {
        const response = await devicePermission(request);
        const element = iframe();
        if (element) element.allow = buildAllowAttribute(state.grantedPermissions);
        return response;
      },
    },
  };
}

/** Forwards the host page's path, query and hash so a deep link reaches the product. */
function productIframeUrl(productUrl: string): string {
  const { pathname, search, hash } = window.location;
  return new URL(pathname + search + hash, productUrl).href;
}

/**
 * `createIframeHost` builds its own iframe, so the placeholder only lends its
 * parent and its `#product-frame` id — which is what the fixture locates the
 * product by. Returned rather than removed, so a throw leaves the page intact.
 */
function placeholderSlot(): { container: HTMLElement; placeholder: Element | null } {
  const placeholder = document.getElementById('product-frame');
  return { container: placeholder?.parentElement ?? document.body, placeholder };
}

async function init(): Promise<void> {
  const config = window.__TEST_HOST_CONFIG__;
  if (!config) {
    console.error('[test-host] No __TEST_HOST_CONFIG__ found');
    return;
  }

  const store = createLoopbackStore();
  const state = createHostState();
  applyInitialConfig(state, config);

  /** The accounts in force. Replaced by `setAccounts`. */
  let accounts = config.accounts;
  if (accounts.length === 0) {
    // The session carries exactly one identity, and it is the first account.
    console.error('[test-host] No accounts configured');
    return;
  }
  const resolveAccount: ResolveAccount = (dotNsIdentifier, derivationIndex) =>
    resolveProductAccount(
      { accounts, productAccounts: config.productAccounts },
      dotNsIdentifier,
      derivationIndex,
    );

  let session = mintSession(deriveFromUri(accounts[0].uri), usernameOf(accounts[0]));
  let responder = createSsoResponder({ store, session, resolveAccount });
  /** Signing recorded by responders retired by an account switch. */
  const retiredSigningLog: SigningLogEntry[] = [];

  let iframeHost: IframeHost | undefined;
  const callbacks = withIframePermissionsPolicy(
    createHostCallbacks({ state, store, networks: config.networks }),
    state,
    () => iframeHost?.iframe,
  );

  // Held in a local so a rejected runtime (bad chunk, wasm that will not
  // instantiate) does not leak a worker nothing else holds.
  const worker = createHostWorker();
  const runtime = await createWebWorkerPairingHostRuntime(worker, callbacks, {
    hostConfig: {
      host: { name: 'Test Host', platform: 'Web' },
      // The loopback store answers this genesis in-page. The other two come
      // from the configured networks: the core routes Bulletin and Asset Hub by
      // the genesis it was handed here, not by anything `supportedChains()`
      // reports, so a network configured but not declared here is unreachable
      // to the core however well `chain.connect` could serve it.
      people: { genesisHash: PEOPLE_GENESIS_HASH },
      bulletin: { genesisHash: genesisForRole(config.networks, 'Bulletin') },
      assetHub: { genesisHash: genesisForRole(config.networks, 'AssetHub') },
      pairing: { deeplinkScheme: 'testhost' },
    },
  }).catch((cause: unknown) => {
    worker.terminate();
    throw cause;
  });

  // The PRODUCT connection, tracked here because only the bridge knows it. The
  // host's OWN session is separate: the core reports it through
  // `auth.authStateChanged`, and `getChainStatus()` answers from that.
  let productStatus = 'disconnected';
  const productIsTalking = () => {
    productStatus = 'connected';
  };

  try {
    await runtime.activateExternalSession(encodeExternalPairedSession(session));

    const productId = config.productId ?? DEFAULT_PRODUCT_ID;
    const executionKind = config.executionKind ?? DEFAULT_EXECUTION_KIND;
    let provider = await runtime.createProvider({ productId, executionKind });

    // `createIframeHost` hands the port over synchronously, before the iframe
    // loads, so the provider takes a promise.
    let handOverPort!: (port: MessagePort) => void;
    const portProvider = createMessagePortProvider(
      new Promise<MessagePort>((resolve) => {
        handOverPort = resolve;
      }),
    );

    const { container, placeholder } = placeholderSlot();
    let host: IframeHost;
    try {
      host = createIframeHost({
        iframeUrl: productIframeUrl(config.productUrl),
        container,
        onPort: handOverPort,
        allow: buildAllowAttribute(state.grantedPermissions),
        sandbox: PRODUCT_SANDBOX,
      });
    } catch (cause) {
      // Thrown synchronously for a non-http(s) product URL. The placeholder is
      // still in the page, so a test locating the frame finds an element.
      throw new Error(`could not embed the product at ${config.productUrl}`, { cause });
    }
    // Removed only now, so the page never carries two `#product-frame` elements.
    placeholder?.remove();
    host.iframe.id = 'product-frame';
    iframeHost = host;

    let unbridge = bridgeProviders(portProvider, provider, productIsTalking);

    /**
     * Re-mint the session for `names` and resume routing. The FIRST name is the
     * active identity and the only one that signs.
     *
     * The iframe is deliberately left alone: its `MessagePort` was transferred
     * once, at load, so reloading it would strand the channel.
     */
    async function setAccounts(names: string[]): Promise<void> {
      if (names.length === 0) throw new Error('setAccounts requires at least one account');
      accounts = names.map((name) => resolveAccountName(config.accounts, name));

      productStatus = 'disconnected';
      retiredSigningLog.push(...responder.getSigningLog());
      responder.dispose();
      session = mintSession(deriveFromUri(accounts[0].uri), usernameOf(accounts[0]));
      responder = createSsoResponder({ store, session, resolveAccount });

      // No unwind: if activation then fails, the core has already reported the
      // drop and `getChainStatus()` reads `'disconnected'`.
      await runtime.resetSessionState();
      await runtime.activateExternalSession(encodeExternalPairedSession(session));

      // The port provider does not buffer — a frame arriving while nothing is
      // subscribed is dropped — and the product keeps talking across the swap.
      const parked: Uint8Array[] = [];
      const stopParking = portProvider.subscribe((frame) => {
        productIsTalking();
        parked.push(frame);
      });
      unbridge();

      try {
        provider.dispose();
        provider = await runtime.createProvider({ productId, executionKind });
      } finally {
        // A parking subscriber left attached would grow `parked` unboundedly.
        stopParking();
      }

      for (const frame of parked) provider.postMessage(frame);
      unbridge = bridgeProviders(portProvider, provider, productIsTalking);
    }

    /** Stable handle over a responder that account switching replaces, so the log survives. */
    const responderFacade: SsoResponder = {
      getSigningLog: () => [...retiredSigningLog, ...responder.getSigningLog()],
      clearSigningLog: () => {
        retiredSigningLog.length = 0;
        responder.clearSigningLog();
      },
      dispose: () => responder.dispose(),
    };

    window.__TEST_HOST__ = buildControlApi({
      state,
      networks: config.networks,
      responder: responderFacade,
      runtime,
      iframeHost: host,
      provider: (): TrUApiProductProvider => provider,
      setAccounts,
      connectionStatus: () => productStatus,
      disposeBridge: () => {
        unbridge();
        portProvider.dispose();
      },
    });

    console.log(
      '[test-host] Initialized:',
      '\n  product:',
      productId,
      `(${executionKind})`,
      '\n  networks:',
      config.networks
        .map((network) => `${network.name} (${network.genesisHash.slice(0, 18)}...) ${network.rpcUrl}`)
        .join('\n            '),
      '\n  accounts:',
      accounts.map((account) => account.name).join(', '),
    );
  } catch (error) {
    // The page stays up after a failed boot, so the WASM worker must not.
    runtime.dispose();
    throw error;
  }
}

void init().catch((error) => {
  console.error('[test-host] Init failed:', error);
});
