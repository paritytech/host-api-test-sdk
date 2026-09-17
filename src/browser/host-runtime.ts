/**
 * Browser-side host runtime — the boot sequence for the in-page TrUAPI host.
 *
 * Reads `window.__TEST_HOST_CONFIG__`, then brings up, in this order (the
 * order matters, each step is the previous one's input):
 *
 *   1. the in-page loopback statement store and the callback state bag;
 *   2. an SSO session, BOTH halves of which this page mints — there is no
 *      wallet and no network here, so the host also plays the peer;
 *   3. the SSO responder, which answers every signing request off the
 *      loopback store with dev keys;
 *   4. the WASM core in a Web Worker, wired to the host callback groups;
 *   5. `activateExternalSession`, installing the minted session;
 *   6. the product provider and the product iframe, bridged port-to-provider.
 *
 * Nothing leaves the page: no node, no signer process, no network at boot.
 *
 * Exposes `window.__TEST_HOST__` (see `control-api.ts`) for Playwright.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { createMessagePortProvider } from '@parity/truapi';
import type { WireProvider } from '@parity/truapi';
import type { RequiredHostCallbacks, TrUApiProductProvider } from '@parity/truapi-host';
import type { IframeHost } from '@parity/truapi-host/web';
import { createIframeHost, createWebWorkerPairingHostRuntime } from '@parity/truapi-host/web';

import { buildAllowAttribute, buildControlApi } from './control-api.js';
import type { ChainRuntimeConfig, HostState } from './callbacks/index.js';
import { createHostCallbacks, createHostState } from './callbacks/index.js';
import { PEOPLE_GENESIS_HASH, ZERO_HASH } from './constants.js';
import type { DevKeypair } from './dev-accounts.js';
import { deriveDev, deriveFromUri } from './dev-accounts.js';
import { createHostWorker } from './host-worker.js';
import { createLoopbackStore } from './loopback-chain.js';
import { resolveProductAccount } from './product-accounts.js';
import type { ResponderSession, SigningLogEntry, SsoResponder } from './sso/responder.js';
import { createSsoResponder } from './sso/responder.js';
import type { ResolveAccount } from './sso/ring-vrf.js';
import { encodeExternalPairedSession } from './sso/session-blob.js';
import type { TestHostAPI } from '../types.js';

interface AccountConfig {
  name: string;
  uri: string;
}

interface HostConfig {
  productUrl: string;
  /** dotNS identifier the product runs as. */
  productId?: string;
  accounts: AccountConfig[];
  /** Networks the host can route, matched by genesis. First is the default. */
  networks: ChainRuntimeConfig[];
  /** Maps "dotnsId/index" → { name, uri } for product account overrides. */
  productAccounts?: Record<string, AccountConfig>;
}

declare global {
  interface Window {
    __TEST_HOST_CONFIG__: HostConfig;
    __TEST_HOST__: TestHostAPI;
  }
}

/** Matches the sandbox the pre-migration host page put on the product iframe. */
const PRODUCT_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

/** dotNS identifier used when the page config names no product. */
const DEFAULT_PRODUCT_ID = 'test-product.dot';

const encoder = new TextEncoder();

/**
 * Mint both halves of an SSO session for one signer.
 *
 * A paired host holds only its own half and the peer's public key; this page
 * is also the peer, so it keeps `peerEncSecret` too and hands it to the
 * responder. `identityAccountId` is the peer's statement-store account id and
 * the key every application reply must be signed by — hence `identitySecret`
 * is the signer's own secret, which the responder verifies at construction.
 */
function mintSession(signer: DevKeypair): ResponderSession {
  const statementStore = deriveDev('Alice', 'statement-store');
  const peerEncSecret = x25519.utils.randomSecretKey();
  return {
    rootPublicKey: signer.publicKey,
    identityAccountId: signer.publicKey,
    identitySecret: signer.secretKey,
    // Per-signer and non-zero, so two accounts never derive the same product
    // entropy the way an all-zero source would.
    rootEntropySource: blake2b(concat(signer.publicKey, encoder.encode('root-entropy')), { dkLen: 32 }),
    encSecret: x25519.utils.randomSecretKey(),
    peerEncPubkey: x25519.getPublicKey(peerEncSecret),
    peerEncSecret,
    ssSecret: statementStore.secretKey,
    ssPublicKey: statementStore.publicKey,
    sessionIdOwn: crypto.getRandomValues(new Uint8Array(32)),
    sessionIdPeer: crypto.getRandomValues(new Uint8Array(32)),
  };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/** `'alice'` → `{ name: 'Alice', uri: '//Alice' }`, as pre-migration did. */
function devAccount(name: string): AccountConfig {
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return { name: capitalized, uri: `//${capitalized}` };
}

/**
 * Two-way pipe between two wire providers.
 *
 * The product's `MessagePort` and the core's product provider are both
 * `WireProvider`s carrying the same SCALE wire frames, so relaying one into
 * the other is the whole bridge — no translation, no framing, no filtering.
 * `onFrameFromLeft` is how the product's connection status is observed: the
 * first frame off the port is the product actually talking.
 * Returns the disposer that stops both directions.
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
 * Re-apply the iframe's Permissions Policy whenever a device permission is
 * answered.
 *
 * The callback groups know nothing about the iframe, but a granted `Camera`
 * belongs in the `allow` attribute, as the pre-migration
 * `handleDevicePermission` put it there. Note what that buys and what it does
 * not: a Permissions Policy only takes effect at navigation, so — exactly as
 * pre-migration noted — this applies on the NEXT navigation or iframe
 * recreation, not to the document already loaded. Pre-migration at least
 * re-navigated the iframe on an account switch; this host deliberately does
 * not (see `setAccounts`), so today nothing re-navigates it and the attribute
 * is written for a future load. It is kept because it is correct and because
 * it is what makes a rebuilt iframe inherit the right policy.
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

/**
 * Where the product iframe points.
 *
 * The host page's own path, query and hash are forwarded so a deep link
 * opened against the test host reaches the product unchanged.
 */
function productIframeUrl(productUrl: string): string {
  const { pathname, search, hash } = window.location;
  return new URL(pathname + search + hash, productUrl).href;
}

/**
 * The page's placeholder iframe slot.
 *
 * `createIframeHost` builds its own iframe, so the placeholder is handed over
 * rather than reused: its parent becomes the container, and the new iframe
 * takes its `#product-frame` id — that is what the Playwright fixture locates
 * the product by. The placeholder is returned rather than removed here, so a
 * `createIframeHost` that throws leaves the page intact.
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

  /** The accounts in force. Replaced by `setAccounts`. */
  let accounts = config.accounts;
  if (accounts.length === 0) {
    // The session has exactly one identity, and it is the first account, so
    // there is nothing to boot without one.
    console.error('[test-host] No accounts configured');
    return;
  }
  const resolveAccount: ResolveAccount = (dotNsIdentifier, derivationIndex) =>
    resolveProductAccount(
      { accounts, productAccounts: config.productAccounts },
      dotNsIdentifier,
      derivationIndex,
    );

  let session = mintSession(deriveFromUri(accounts[0].uri));
  let responder = createSsoResponder({ store, session, resolveAccount });
  /** Signing recorded by responders retired by an account switch. */
  const retiredSigningLog: SigningLogEntry[] = [];

  let iframeHost: IframeHost | undefined;
  const callbacks = withIframePermissionsPolicy(
    createHostCallbacks({ state, store, networks: config.networks }),
    state,
    () => iframeHost?.iframe,
  );

  const runtime = await createWebWorkerPairingHostRuntime(createHostWorker(), callbacks, {
    hostConfig: {
      host: { name: 'Test Host', platform: 'Web' },
      // The loopback store answers this genesis in-page; the other two are
      // all-zero, which declares "this host deliberately has no such chain".
      people: { genesisHash: PEOPLE_GENESIS_HASH },
      bulletin: { genesisHash: ZERO_HASH },
      assetHub: { genesisHash: ZERO_HASH },
      pairing: { deeplinkScheme: 'testhost' },
    },
  });

  // Two independent readouts, deliberately: `productStatus` is the PRODUCT
  // connection (what the pre-migration `subscribeProductConnectionStatus`
  // reported, and what the fixture's `waitForConnection` gates on), and
  // `sessionStatus` is this host's own session activation. Publishing
  // `__TEST_HOST__` says nothing about either.
  let productStatus = 'disconnected';
  let sessionStatus = 'connecting';
  const productIsTalking = () => {
    productStatus = 'connected';
  };

  try {
    await runtime.activateExternalSession(encodeExternalPairedSession(session));
    sessionStatus = 'connected';

    const productId = config.productId ?? DEFAULT_PRODUCT_ID;
    let provider = await runtime.createProvider({ productId });

    // `createIframeHost` hands the port over synchronously, before the iframe
    // loads; the provider takes the promise and buffers until it arrives.
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
      // `createIframeHost` rejects a non-http(s) product URL synchronously.
      // The placeholder is still in the page, so a test locating the frame
      // gets an empty product rather than a missing element, and this error
      // names the real cause.
      throw new Error(`could not embed the product at ${config.productUrl}`, { cause });
    }
    // Only now is the placeholder redundant — and it holds the id until it is
    // gone, so the page never carries two `#product-frame` elements.
    placeholder?.remove();
    host.iframe.id = 'product-frame';
    iframeHost = host;

    let unbridge = bridgeProviders(portProvider, provider, productIsTalking);

    /**
     * Re-mint the session for `names` and resume routing.
     *
     * The iframe is deliberately left alone: its `MessagePort` was transferred
     * once, at load, and reloading it would strand the channel. So the session
     * is dropped and re-installed under the new signer and the product
     * provider is replaced over the same port.
     */
    async function setAccounts(names: string[]): Promise<void> {
      if (names.length === 0) throw new Error('setAccounts requires at least one account');
      accounts = names.map(devAccount);

      productStatus = 'disconnected';
      sessionStatus = 'connecting';
      retiredSigningLog.push(...responder.getSigningLog());
      responder.dispose();
      session = mintSession(deriveFromUri(accounts[0].uri));
      responder = createSsoResponder({ store, session, resolveAccount });

      try {
        await runtime.resetSessionState();
        await runtime.activateExternalSession(encodeExternalPairedSession(session));

        // The port provider does not buffer: a frame delivered while nothing
        // is subscribed is dropped on the floor. The product keeps talking
        // across the swap, so park its frames for the duration rather than
        // lose them.
        const parked: Uint8Array[] = [];
        const stopParking = portProvider.subscribe((frame) => {
          productIsTalking();
          parked.push(frame);
        });
        unbridge();

        try {
          provider.dispose();
          provider = await runtime.createProvider({ productId });
        } finally {
          // Unsubscribe even when the swap fails. A parking subscriber left
          // attached would grow `parked` unboundedly and keep reporting the
          // product as talking while no frame reaches any core.
          stopParking();
        }

        for (const frame of parked) provider.postMessage(frame);
        unbridge = bridgeProviders(portProvider, provider, productIsTalking);
        sessionStatus = 'connected';
      } catch (error) {
        // Never leave a failed switch claiming to be connected.
        sessionStatus = 'disconnected';
        throw error;
      }
    }

    /**
     * A stable responder handle over a responder that account switching
     * replaces, so the signing log survives a switch as it did pre-migration.
     */
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
      responder: responderFacade,
      runtime,
      iframeHost: host,
      provider: (): TrUApiProductProvider => provider,
      setAccounts,
      connectionStatus: () => productStatus,
      chainStatus: () => sessionStatus,
      disposeBridge: () => {
        unbridge();
        portProvider.dispose();
      },
    });

    console.log(
      '[test-host] Initialized:',
      '\n  product:',
      productId,
      '\n  networks:',
      config.networks
        .map((network) => `${network.name} (${network.genesisHash.slice(0, 18)}...) ${network.rpcUrl}`)
        .join('\n            '),
      '\n  accounts:',
      accounts.map((account) => account.name).join(', '),
    );
  } catch (error) {
    // A half-booted host must not leave the WASM worker running: the page
    // stays up after a failed boot, and Playwright would otherwise report a
    // missing `__TEST_HOST__` against a still-spinning core.
    runtime.dispose();
    throw error;
  }
}

void init().catch((error) => {
  console.error('[test-host] Init failed:', error);
});
