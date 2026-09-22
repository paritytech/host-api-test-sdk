/**
 * End-to-end tests for the migrated host: a real product, in a real iframe,
 * talking to the WASM core in its Web Worker over the protocol.
 *
 * The product (`test-product.ts`) boots through `@parity/truapi/sandbox` and
 * exposes every call under `window.__TEST_PRODUCT__`; the host exposes its
 * control plane under `window.__TEST_HOST__`. Nothing here touches the
 * network: chain traffic is either the in-page loopback People store (which
 * carries signing) or nothing at all.
 *
 * Signing is no longer a synchronous in-page callback — it is a round trip
 * from the core, out over the SSO channel as a statement, and back — so every
 * signing assertion awaits the answer rather than reading it off a log.
 */

import { test, expect } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import { compactFromU8a, hexToU8a, u8aToHex } from '@polkadot/util';
import { verify } from '@scure/sr25519';
import { createTestHostServer, PASEO_ASSET_HUB } from '../dist/index.js';
import type { NetworkConfig } from '../dist/index.js';
// Type-only: brings in the `window.__TEST_HOST__` declaration the fixture
// publishes, so the control-plane calls below are checked against it.
import type {} from '../dist/playwright/index.js';
// The SDK's own derivation, so expected keys come from one source of truth
// rather than a second keyring implementation in the tests.
import { deriveDev, deriveFromUri, deriveSoft } from '../src/browser/dev-accounts.js';
// `index_bytes(n)` — the soft chain code the CORE derives a product account
// at. Imported rather than restated so the two cannot drift apart.
import { indexBytes } from '../src/browser/product-accounts.js';
// The synthetic genesis of the in-page People loopback — the one chain this
// host always serves. Imported rather than restated so it cannot drift.
import { PEOPLE_GENESIS_HASH } from '../src/browser/constants.js';
import { loadHost, serveProduct } from './support.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Narrow a product call's outcome, failing the test with the host's reason. */
function expectOk<R extends object>(
  outcome: ({ ok: true } & R) | { ok: false; error: string },
): R {
  if (!outcome.ok) throw new Error(`product call failed: ${outcome.error}`);
  return outcome;
}

/** Get the product iframe as a Frame (supports evaluate, unlike FrameLocator). */
function getProductFrame(page: Page, productUrl: string): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(productUrl));
  if (!frame) throw new Error('Product frame not found');
  return frame;
}

/**
 * Load the host, wait until the product has actually spoken to it, and return
 * the evaluable product frame.
 *
 * The gate is the host's own product-connection readout plus the product
 * publishing its test surface — not a signed account fetch, which is a full
 * SSO round trip and is the subject of its own tests.
 */
async function loadHostAndProduct(page: Page, hostUrl: string, productUrl: string): Promise<Frame> {
  const frameLocator = await loadHost(page, hostUrl);
  await page.waitForFunction(
    () => window.__TEST_HOST__.getConnectionStatus() === 'connected',
    { timeout: 30_000 },
  );
  await expect(frameLocator.locator('#status[data-ready="true"]')).toBeAttached({ timeout: 30_000 });
  return getProductFrame(page, productUrl);
}

/**
 * A subscription's items arrive asynchronously, so a spec waits for the shape
 * it expects rather than reading the sink once.
 */
async function expectStorageItems(product: Frame, expected: Array<string | null>): Promise<void> {
  await expect
    .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedLocalStorage()))
    .toEqual(expected);
}

/** Read the product account key the test product received from the host. */
async function getProductPublicKey(page: Page, hostUrl: string): Promise<string> {
  const frame = await loadHost(page, hostUrl);
  const key = frame.locator('#product-key[data-ready="true"]');
  await expect(key).toBeAttached({ timeout: 30_000 });
  return (await key.textContent())!;
}

/** The same key, off a product frame that is already loaded. */
async function readProductKey(product: Frame): Promise<string> {
  const key = product.locator('#product-key[data-ready="true"]');
  await expect(key).toBeAttached({ timeout: 30_000 });
  return (await key.textContent())!;
}

/** `//Alice` → its 32-byte public key as hex, the way the host derives it. */
const keyOf = (uri: string) => u8aToHex(deriveFromUri(uri).publicKey);

/** The bytes a watermarked raw-signing request actually signs. */
const watermarked = (payload: Uint8Array): Uint8Array =>
  new Uint8Array([
    ...new TextEncoder().encode('<Bytes>'),
    ...payload,
    ...new TextEncoder().encode('</Bytes>'),
  ]);

/** Split a signed v4 extrinsic into the parts the assertions below check. */
function decodeSignedExtrinsic(signedHex: string) {
  const wire = hexToU8a(signedHex);
  const [offset, innerLength] = compactFromU8a(wire);
  const bytes = wire.slice(offset);
  return {
    bytes,
    innerLength: innerLength.toNumber(),
    version: bytes[0],
    addressType: bytes[1],
    signer: bytes.slice(2, 34),
    signatureType: bytes[34],
    signature: bytes.slice(35, 99),
    callData: bytes.slice(99, 101),
  };
}

// ── Setup ───────────────────────────────────────────────────────────

let productServer: Awaited<ReturnType<typeof serveProduct>>;

test.beforeAll(async () => {
  productServer = await serveProduct('test-product.html', 'test-product-bundle.js');
});

test.afterAll(async () => {
  await productServer?.close();
});

// ── Tests ───────────────────────────────────────────────────────────

test.describe('Control API', () => {

  /**
   * The host page only — no product. Every control that writes host state is
   * driven through the real `window.__TEST_HOST__` and read back through its
   * own getter, by value: what each pair proves is that the write happened and
   * landed where the reader looks, which a handler test against a hand-mutated
   * `HostState` cannot see.
   */
  test('every writable control is read back by its own getter', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      networks: [PASEO_ASSET_HUB],
    });

    try {
      await loadHost(page, host.url);

      const written = await page.evaluate(() => {
        const api = window.__TEST_HOST__;
        api.setDevicePermissionStatus('Camera', 'Denied');
        api.setFeatureSupport('Chain', false);
        api.seedChatBot({ botId: 'bot-1', name: 'Helper', icon: 'https://example.com/i.png' });
        api.setSupportedChains([{ identifier: 'Relay', genesisHash: '0xfeed' }]);
        return {
          statuses: api.getDevicePermissionStatuses(),
          features: api.getFeatureSupport(),
          bots: api.getChatBots(),
          chains: api.getSupportedChains(),
        };
      });

      expect(written.statuses).toEqual({ Camera: 'Denied' });
      expect(written.features).toEqual({ Chain: false });
      expect(written.bots).toEqual([
        { botId: 'bot-1', name: 'Helper', icon: 'https://example.com/i.png' },
      ]);
      expect(written.chains).toEqual([{ identifier: 'Relay', genesisHash: '0xfeed' }]);

      const reset = await page.evaluate(() => {
        const api = window.__TEST_HOST__;
        api.setDevicePermissionStatus('Camera', undefined);
        api.setFeatureSupport('Chain', undefined);
        api.setSupportedChains(undefined);
        return {
          statuses: api.getDevicePermissionStatuses(),
          features: api.getFeatureSupport(),
          chains: api.getSupportedChains(),
        };
      });

      expect(reset.statuses).toEqual({});
      expect(reset.features).toEqual({});
      // The derived set is back: the in-page People loopback plus the one
      // configured network that declares a role.
      expect(reset.chains.map((chain) => chain.identifier)).toEqual(['People', 'AssetHub']);
    } finally {
      await host.close();
    }
  });
});

test.describe('Product account derivation', () => {
  /**
   * The host does not answer for an indexed product account, and cannot: the
   * core asks once for the product's HARD SUBTREE (`ProductSubtreeRequest`)
   * and then derives every account under it ITSELF, as one soft junction over
   * that subtree public key —
   * `derive_product_public_key(subtree, index_bytes(n))`
   * (`truapi-server/src/host_logic/product_account.rs`, reached from
   * `runtime.rs::product_account_public_key`).
   *
   * So the host's one lever is WHICH keypair is the subtree, and its job is to
   * sign with the same soft derivation. That is the property the first test
   * below checks end to end: a signature the product obtains verifies against
   * the address the CORE reported to it.
   */

  /** The account the core derives for `dotnsId` index `n` under one subtree. */
  const productAccount = (subtreeUri: string, index: number) =>
    deriveSoft(deriveFromUri(subtreeUri), indexBytes(index));

  test('a product signs with the very key the core reported to it', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // The product calls getAccount("test-product.dot", 0). With no mapping
      // the subtree is //Bob//test-product.dot and the account is that subtree
      // soft-derived at index_bytes(0).
      const reported = await readProductKey(product);
      expect(reported).toBe(u8aToHex(productAccount('//Bob//test-product.dot', 0).publicKey));
      expect(reported).not.toBe(keyOf('//Bob'));
      // The subtree root itself is a different account from index 0.
      expect(reported).not.toBe(keyOf('//Bob//test-product.dot'));

      // The regression this suite exists for: before the host signed with the
      // soft derivation, it hard-derived //Bob//test-product.dot/0 instead, so
      // this verify() failed against the product's own address.
      const payload = `0x${'5a'.repeat(16)}`;
      const signed = expectOk(
        await product.evaluate(
          (p) => window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, p),
          payload,
        ),
      );
      expect(
        verify(watermarked(hexToU8a(payload)), hexToU8a(signed.signature), hexToU8a(reported)),
      ).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('productAccounts moves a product subtree to a specific dev account', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
      // Keyed by the bare product id: the mapping replaces the SUBTREE, and
      // every indexed account under it moves with it.
      productAccounts: { 'test-product.dot': 'alice' },
    });

    try {
      expect(await getProductPublicKey(page, host.url)).toBe(
        u8aToHex(productAccount('//Alice', 0).publicKey),
      );
    } finally {
      await host.close();
    }
  });

  test('productAccounts supports custom URIs', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
      productAccounts: { 'test-product.dot': { name: 'Charlie', uri: '//Charlie' } },
    });

    try {
      expect(await getProductPublicKey(page, host.url)).toBe(
        u8aToHex(productAccount('//Charlie', 0).publicKey),
      );
    } finally {
      await host.close();
    }
  });

  test('unmapped products fall back to the derived subtree', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
      productAccounts: { 'other-app.dot': 'alice' }, // different product, won't match
    });

    try {
      expect(await getProductPublicKey(page, host.url)).toBe(
        u8aToHex(productAccount('//Bob//test-product.dot', 0).publicKey),
      );
    } finally {
      await host.close();
    }
  });

  /**
   * The core refuses any product-account call whose `dotNsIdentifier` is not
   * the id the host declared the product under, so a host stuck on one id can
   * only ever serve one product.
   */
  test('only the configured productId may sign with product accounts', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      productId: 'other-product.dot',
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('other-product.dot', 0, '0x1234'),
        ),
      );
      expect(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x1234'),
        ),
      ).toEqual({ ok: false, error: 'PermissionDenied' });
    } finally {
      await host.close();
    }
  });
});

test.describe('Legacy (non-product) accounts', () => {

  test('the core does not enumerate legacy accounts', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice', 'bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Legacy accounts are addressable by id but never listed — the core
      // answers with an empty vector whatever the host holds. A product that
      // wants one must already know which account it means.
      const result = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.getLegacyAccounts()),
      );
      expect(result.keys).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

// ── Permission enforcement ──────────────────────────────────────────

test.describe('Permission handling', () => {

  test('ChainSubmit permission request is logged', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const permission = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.requestChainSubmit()),
      );
      expect(permission.approved).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((entry) => entry.tag === 'ChainSubmit' && entry.approved)).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('permission is rejected when behavior is reject-all', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(() => window.__TEST_HOST__.setPermissionBehavior('reject-all'));

      const permission = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.requestChainSubmit()),
      );
      expect(permission.approved).toBe(false);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((entry) => entry.tag === 'ChainSubmit' && !entry.approved)).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Device permission handling ──────────────────────────────────────

test.describe('Device permissions', () => {

  test('device permission request is tracked and approved by default', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.requestDevicePermission('Camera')),
      );
      expect(result.approved).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((entry) => entry.tag === 'Camera' && entry.approved)).toBe(true);

      const granted = await page.evaluate(() => window.__TEST_HOST__.getGrantedPermissions());
      expect(granted).toContain('Camera');
    } finally {
      await host.close();
    }
  });

  test('device permission is rejected when behavior is reject-all', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(() => window.__TEST_HOST__.setPermissionBehavior('reject-all'));

      const result = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.requestDevicePermission('Microphone')),
      );
      expect(result.approved).toBe(false);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((entry) => entry.tag === 'Microphone' && !entry.approved)).toBe(true);

      const granted = await page.evaluate(() => window.__TEST_HOST__.getGrantedPermissions());
      expect(granted).not.toContain('Microphone');
    } finally {
      await host.close();
    }
  });

  test('Remote permission is tracked with the requested domains', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.requestRemote('example.com')),
      );
      expect(result.approved).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      const remote = log.find((entry) => entry.tag === 'Remote');
      expect(remote?.approved).toBe(true);
      expect(remote?.value).toEqual({ domains: ['example.com'] });
    } finally {
      await host.close();
    }
  });
});

// ── Navigation ──────────────────────────────────────────────────────

test.describe('Navigation', () => {

  test('navigateTo is recorded in the navigation log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const initial = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(initial).toEqual([]);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.navigateTo('polkadot://example.dot/settings'),
        ),
      );

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(log).toHaveLength(1);
      // A dotNS link is an app handoff, so the core categorizes it and passes
      // it through for the host's own URL handler rather than rewriting it to
      // an https form.
      expect(log[0].url).toBe('polkadot://example.dot/settings');
      expect(typeof log[0].timestamp).toBe('number');
    } finally {
      await host.close();
    }
  });

  test('multiple navigation requests are all recorded in order', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('polkadot://foo.dot'));
      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('dot://bar.dot/page'));

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      // In the order the product asked for them, and normalized: `dot:` is the
      // same app-handoff scheme as `polkadot:` and arrives spelled that way.
      expect(log.map((entry) => entry.url)).toEqual([
        'polkadot://foo.dot',
        'polkadot://bar.dot/page',
      ]);
    } finally {
      await host.close();
    }
  });

  test('clearNavigationLog empties the log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('polkadot://a.dot'));
      await page.evaluate(() => window.__TEST_HOST__.clearNavigationLog());

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(log).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test('a refused navigation surfaces to the product and is still logged', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await page.evaluate(() => window.__TEST_HOST__.setNavigationBehavior('reject-all'));

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.navigateTo('polkadot://blocked.dot'),
      );

      expect(result.ok).toBe(false);
      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(log.some((entry) => entry.url.includes('blocked'))).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('an external URL is gated by the OpenUrl device permission, a dotNS link is not', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      behaviors: { permission: 'reject-all' },
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const external = await product.evaluate(() =>
        window.__TEST_PRODUCT__.navigateTo('https://example.com/page'),
      );
      expect(external).toEqual({ ok: false, error: 'PermissionDenied' });

      // The dotNS schemes are app handoffs the core never gates, so this one
      // reaches the host under the very same denial.
      expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('polkadot://ok.dot')),
      );

      expect(
        await page.evaluate(() => window.__TEST_HOST__.getNavigationLog().map((e) => e.url)),
      ).toEqual(['polkadot://ok.dot']);
      expect(
        await page.evaluate(() => window.__TEST_HOST__.getPermissionLog().map((e) => e.tag)),
      ).toEqual(['OpenUrl']);
    } finally {
      await host.close();
    }
  });

  // The clearest end-to-end proof that the two grant lifetimes differ: a
  // lasting grant is asked for once, a one-use grant on every call.
  test('a one-use OpenUrl grant is re-asked per URL, a lasting one is asked once', async ({ page }) => {
    for (const [mode, expected] of [
      ['approve-once', 2],
      ['approve-all', 1],
    ] as const) {
      const host = await createTestHostServer({
        productUrl: productServer.url,
        accounts: ['alice'],
        behaviors: { permission: mode },
      });

      try {
        const product = await loadHostAndProduct(page, host.url, productServer.url);

        expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('https://a.test/')));
        expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('https://b.test/')));

        const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
        expect(log.filter((entry) => entry.tag === 'OpenUrl')).toHaveLength(expected);
        expect(log.every((entry) => entry.approved)).toBe(true);
        expect(
          await page.evaluate(() => window.__TEST_HOST__.getNavigationLog()),
        ).toHaveLength(2);
      } finally {
        await host.close();
      }
    }
  });
});

// ── Push notifications ──────────────────────────────────────────────

test.describe('Push notifications', () => {

  test('notification without deeplink is recorded', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.pushNotification('You have a new message'),
        ),
      );

      const log = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(log).toHaveLength(1);
      expect(log[0].text).toBe('You have a new message');
      expect(log[0].deeplink).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  test('notification with deeplink is recorded', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.pushNotification('Tap to view', 'polkadot://myapp.dot/message/42'),
        ),
      );

      const log = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(log).toHaveLength(1);
      expect(log[0].text).toBe('Tap to view');
      expect(log[0].deeplink).toBe('polkadot://myapp.dot/message/42');
    } finally {
      await host.close();
    }
  });

  test('clearNotificationLog empties the log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => window.__TEST_PRODUCT__.pushNotification('a'));
      await product.evaluate(() => window.__TEST_PRODUCT__.pushNotification('b'));
      await page.evaluate(() => window.__TEST_HOST__.clearNotificationLog());

      const log = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(log).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test('a refused notification surfaces to the product and is still logged', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await page.evaluate(() => window.__TEST_HOST__.setNotificationBehavior('reject-all'));

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.pushNotification('blocked'),
      );

      expect(result.ok).toBe(false);
      const log = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(log.some((entry) => entry.text === 'blocked')).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('scheduled notification is logged with scheduledAt and can be cancelled', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const scheduled = expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.pushNotification('later', undefined, Date.now() + 60_000),
        ),
      );
      expect(typeof scheduled.notificationId).toBe('number');

      const before = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(before).toHaveLength(1);
      expect(before[0].cancelled).toBe(false);
      expect(typeof before[0].scheduledAt).toBe('bigint');

      expectOk(
        await product.evaluate(
          (id) => window.__TEST_PRODUCT__.pushNotificationCancel(id),
          scheduled.notificationId,
        ),
      );

      const after = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(after[0].cancelled).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Account alias ───────────────────────────────────────────────────

test.describe('Account alias', () => {

  test('getAccountAlias returns a deterministic context and alias', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const first = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0)),
      );
      const second = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0)),
      );

      expect(first.context).toBe(second.context);
      expect(first.alias).toBe(second.alias);
      expect(first.context).toMatch(/^0x[0-9a-f]{64}$/);
      expect(first.alias).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      await host.close();
    }
  });

  test('different accounts get different aliases', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const first = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0)),
      );
      const second = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 1)),
      );

      expect(first.alias).not.toBe(second.alias);
    } finally {
      await host.close();
    }
  });
});

// ── Chat ────────────────────────────────────────────────────────────

test.describe('Chat', () => {

  test('chatCreateRoom returns New for first creation and Exists on repeat', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // `validate_chat_icon` (`truapi-platform/src/lib.rs`) takes an empty
      // string, an `https` URL, or an inline image data URL, and nothing else.
      // Only the URL is parsed — nothing is fetched, so this stays offline.
      const icon = 'https://example.com/room.png';
      const first = expectOk(
        await product.evaluate(
          (i) => window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'r1', name: 'Room 1', icon: i }),
          icon,
        ),
      );
      expect(first.status).toBe('New');

      const second = expectOk(
        await product.evaluate(
          (i) => window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'r1', name: 'Room 1', icon: i }),
          icon,
        ),
      );
      expect(second.status).toBe('Exists');

      const rooms = await page.evaluate(() => window.__TEST_HOST__.getChatRooms());
      expect(rooms).toHaveLength(1);
      expect(rooms[0].roomId).toBe('r1');
      expect(rooms[0].name).toBe('Room 1');
      // The host records the resolved icon the core validated, not the raw input.
      expect(rooms[0].icon).toBe(icon);
      expect(rooms[0].participatingAs).toBe('RoomHost');
    } finally {
      await host.close();
    }
  });

  test('chatRegisterBot returns New/Exists correctly', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // See the icon note in `chatCreateRoom` above.
      const icon = 'https://example.com/bot.png';
      const first = expectOk(
        await product.evaluate(
          (i) => window.__TEST_PRODUCT__.chatRegisterBot({ botId: 'b1', name: 'MyBot', icon: i }),
          icon,
        ),
      );
      expect(first.status).toBe('New');

      const second = expectOk(
        await product.evaluate(
          (i) => window.__TEST_PRODUCT__.chatRegisterBot({ botId: 'b1', name: 'MyBot', icon: i }),
          icon,
        ),
      );
      expect(second.status).toBe('Exists');

      const bots = await page.evaluate(() => window.__TEST_HOST__.getChatBots());
      expect(bots).toHaveLength(1);
      expect(bots[0].botId).toBe('b1');
      expect(bots[0].icon).toBe(icon);
    } finally {
      await host.close();
    }
  });

  test('chatPostMessage fails if the room does not exist', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // A room the product does own, so this test fails on a posting refusal
      // rather than passing because chat is unavailable altogether.
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'owned', name: 'Owned', icon: '' }),
        ),
      );

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatPostTextMessage('no-such-room', 'hello'),
      );
      expect(result.ok).toBe(false);

      const log = await page.evaluate(() => window.__TEST_HOST__.getChatMessageLog());
      expect(log).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test('chatPostMessage succeeds when the room exists and is logged', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'room-a', name: 'A', icon: '' }),
        ),
      );

      const first = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.chatPostTextMessage('room-a', 'hello')),
      );
      const second = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.chatPostTextMessage('room-a', 'world')),
      );
      expect(first.messageId).toBeTruthy();
      expect(second.messageId).not.toBe(first.messageId);

      const log = await page.evaluate(() => window.__TEST_HOST__.getChatMessageLog());
      expect(log).toHaveLength(2);
      expect(log[0].roomId).toBe('room-a');
      expect(log[0].payload).toEqual({ tag: 'Text', value: { text: 'hello' } });
      expect(log[1].payload).toEqual({ tag: 'Text', value: { text: 'world' } });
    } finally {
      await host.close();
    }
  });

  test('chat room subscription replays the current rooms and new ones', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'pre', name: 'Pre', icon: '' }),
        ),
      );

      await product.evaluate(() => {
        window.__CHAT_ROOMS_SUB__ = window.__TEST_PRODUCT__.subscribeChatRooms();
      });

      // The room that existed before the subscription is replayed on subscribe.
      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedChatRooms()))
        .toContainEqual(['pre']);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'post', name: 'Post', icon: '' }),
        ),
      );

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedChatRooms()))
        .toContainEqual(['pre', 'post']);

      await product.evaluate(() => window.__CHAT_ROOMS_SUB__.unsubscribe());
    } finally {
      await host.close();
    }
  });

  test('injectChatAction delivers to subscribers', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => {
        window.__CHAT_ACTIONS_SUB__ = window.__TEST_PRODUCT__.subscribeChatActions();
      });

      await page.evaluate(() =>
        window.__TEST_HOST__.injectChatAction({
          roomId: 'room-x',
          peer: 'peer-1',
          payload: { tag: 'MessagePosted', value: { tag: 'Text', value: { text: 'hi from peer' } } },
        }),
      );

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedChatActions()))
        .toEqual([
          {
            roomId: 'room-x',
            peer: 'peer-1',
            payload: { tag: 'MessagePosted', value: { tag: 'Text', value: { text: 'hi from peer' } } },
          },
        ]);

      await product.evaluate(() => window.__CHAT_ACTIONS_SUB__.unsubscribe());
    } finally {
      await host.close();
    }
  });

  test('clearChat wipes rooms, bots, and messages', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'r1', name: 'R1', icon: '' }),
        ),
      );
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.chatRegisterBot({ botId: 'b1', name: 'B1', icon: '' }),
        ),
      );
      expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.chatPostTextMessage('r1', 'm')));

      // Non-empty before the wipe, so the assertions below are not vacuous.
      expect(await page.evaluate(() => window.__TEST_HOST__.getChatRooms())).toHaveLength(1);

      await page.evaluate(() => window.__TEST_HOST__.clearChat());

      expect(await page.evaluate(() => window.__TEST_HOST__.getChatRooms())).toEqual([]);
      expect(await page.evaluate(() => window.__TEST_HOST__.getChatBots())).toEqual([]);
      expect(await page.evaluate(() => window.__TEST_HOST__.getChatMessageLog())).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test('a room seeded by the test reaches a product already subscribed', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // Chat is Worker-only in the core: every Chat entry point is denied
      // unless the connection's execution kind is `Worker`
      // (`truapi-server/src/runtime/chat.rs`).
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => {
        window.__CHAT_ROOMS_SUB__ = window.__TEST_PRODUCT__.subscribeChatRooms();
      });

      await page.evaluate(() =>
        window.__TEST_HOST__.seedChatRoom({
          roomId: 'seeded',
          name: 'Seeded',
          icon: 'https://example.com/i.png',
          participatingAs: 'RoomHost',
        }),
      );

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedChatRooms()))
        .toContainEqual(['seeded']);

      await product.evaluate(() => window.__CHAT_ROOMS_SUB__.unsubscribe());
    } finally {
      await host.close();
    }
  });
});

// ── Preimage ────────────────────────────────────────────────────────

test.describe('Preimage', () => {

  test('preimageLookup returns a seeded value', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const key = await page.evaluate(() =>
        window.__TEST_HOST__.seedPreimage(new Uint8Array([42, 42, 42])),
      );

      const result = expectOk(
        await product.evaluate((k) => window.__TEST_PRODUCT__.preimageLookup(k), key),
      );
      expect(result.value).toEqual([42, 42, 42]);
    } finally {
      await host.close();
    }
  });

  test('preimageLookup returns null for an unknown key', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(
          (k) => window.__TEST_PRODUCT__.preimageLookup(k),
          `0x${'00'.repeat(32)}`,
        ),
      );
      expect(result.value).toBeNull();
    } finally {
      await host.close();
    }
  });

  test('a seeded preimage is reported as not coming from the product', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      await loadHostAndProduct(page, host.url, productServer.url);

      const key = await page.evaluate(() =>
        window.__TEST_HOST__.seedPreimage(new Uint8Array([1, 2, 3, 4])),
      );

      const preimages = await page.evaluate(() => window.__TEST_HOST__.getPreimages());
      expect(preimages).toHaveLength(1);
      expect(preimages[0].key).toBe(key);
      // There is no host-side preimage submit any more: the product's submit
      // goes out over the chain route, so everything this host knows about was
      // seeded by the test.
      expect(preimages[0].fromProduct).toBe(false);

      await page.evaluate(() => window.__TEST_HOST__.clearPreimages());
      expect(await page.evaluate(() => window.__TEST_HOST__.getPreimages())).toEqual([]);
    } finally {
      await host.close();
    }
  });

  /**
   * Preimage submission is the core's own Bulletin traffic, routed by the
   * genesis the host declared at boot rather than by anything
   * `supportedChains()` reports. Both halves are asserted because only the
   * pair distinguishes "the host named the configured chain" from "the host
   * named nothing and the core fell back to the all-zero genesis".
   */
  test('preimageSubmit reaches the Bulletin network the host configured', async ({ page }) => {
    const BULLETIN: NetworkConfig = {
      id: 'unreachable-bulletin',
      name: 'Unreachable Bulletin',
      genesisHash: `0x${'bb'.repeat(32)}`,
      // Refused at once, so the assertion is on which chain was dialled rather
      // than on a live one answering.
      rpcUrl: 'ws://127.0.0.1:1',
      tokenSymbol: 'UNIT',
      tokenDecimals: 10,
      chain: 'Bulletin',
    };

    for (const { networks, expected } of [
      { networks: [PASEO_ASSET_HUB], expected: `no chain configured for genesis 0x${'00'.repeat(32)}` },
      { networks: [PASEO_ASSET_HUB, BULLETIN], expected: 'ws://127.0.0.1:1' },
    ]) {
      const host = await createTestHostServer({
        productUrl: productServer.url,
        accounts: ['alice'],
        networks,
      });

      try {
        const product = await loadHostAndProduct(page, host.url, productServer.url);
        const outcome = await product.evaluate(() =>
          window.__TEST_PRODUCT__.preimageSubmit('0xdeadbeef'),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? '' : outcome.error).toContain(expected);
      } finally {
        await host.close();
      }
    }
  });
});

// ── Theme ──────────────────────────────────────────────────────────

test.describe('Theme', () => {

  test('theme subscribe delivers the current theme and later changes', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => {
        window.__THEME_SUB__ = window.__TEST_PRODUCT__.subscribeTheme();
      });

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes()))
        .toEqual([{ name: { tag: 'Default', value: undefined }, variant: 'Light' }]);

      await page.evaluate(() => window.__TEST_HOST__.setTheme('dark'));

      await expect
        .poll(async () =>
          (await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes())).at(-1),
        )
        .toEqual({ name: { tag: 'Default', value: undefined }, variant: 'Dark' });

      await product.evaluate(() => window.__THEME_SUB__.unsubscribe());
    } finally {
      await host.close();
    }
  });

  test('theme subscribe delivers a custom-named theme struct', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Drive a non-default theme from the host before the product subscribes.
      await page.evaluate(() =>
        window.__TEST_HOST__.setTheme({ name: { tag: 'Custom', value: 'midnight' }, variant: 'Dark' }),
      );

      await product.evaluate(() => {
        window.__THEME_SUB__ = window.__TEST_PRODUCT__.subscribeTheme();
      });

      await expect
        .poll(async () =>
          (await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes())).at(-1),
        )
        .toEqual({ name: { tag: 'Custom', value: 'midnight' }, variant: 'Dark' });

      const current = await page.evaluate(() => window.__TEST_HOST__.getTheme());
      expect(current).toEqual({ name: { tag: 'Custom', value: 'midnight' }, variant: 'Dark' });

      await product.evaluate(() => window.__THEME_SUB__.unsubscribe());
    } finally {
      await host.close();
    }
  });
});

// ── Locale ─────────────────────────────────────────────────────────

test.describe('Locale', () => {

  test('a locale change reaches a subscribed product', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expect(await page.evaluate(() => window.__TEST_HOST__.getLocale())).toBe('en');

      await product.evaluate(() => {
        window.__LOCALE_SUB__ = window.__TEST_PRODUCT__.subscribeLocale();
      });

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedLocales()))
        .toEqual(['en']);

      await page.evaluate(() => window.__TEST_HOST__.setLocale('pt-BR'));

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedLocales()))
        .toContain('pt-BR');
      expect(await page.evaluate(() => window.__TEST_HOST__.getLocale())).toBe('pt-BR');

      await product.evaluate(() => window.__LOCALE_SUB__.unsubscribe());
    } finally {
      await host.close();
    }
  });
});

// ── Entropy ────────────────────────────────────────────────────────

test.describe('Entropy', () => {

  test('deriveEntropy returns a 32-byte deterministic result', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const context = `0x${'01'.repeat(16)}`;
      const first = expectOk(
        await product.evaluate((c) => window.__TEST_PRODUCT__.deriveEntropy(c), context),
      );
      expect(first.entropyHex).toMatch(/^0x[0-9a-f]{64}$/);

      const again = expectOk(
        await product.evaluate((c) => window.__TEST_PRODUCT__.deriveEntropy(c), context),
      );
      expect(again.entropyHex).toBe(first.entropyHex);

      const other = expectOk(
        await product.evaluate(
          (c) => window.__TEST_PRODUCT__.deriveEntropy(c),
          `0x${'02'.repeat(16)}`,
        ),
      );
      expect(other.entropyHex).not.toBe(first.entropyHex);
    } finally {
      await host.close();
    }
  });

  test('entropy is bound to the session identity, not the page', async ({ page }) => {
    const context = `0x${'03'.repeat(16)}`;

    const aliceHost = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });
    let underAlice: string;
    try {
      const product = await loadHostAndProduct(page, aliceHost.url, productServer.url);
      underAlice = expectOk(
        await product.evaluate((c) => window.__TEST_PRODUCT__.deriveEntropy(c), context),
      ).entropyHex;
    } finally {
      await aliceHost.close();
    }

    const bobHost = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
    });
    try {
      const product = await loadHostAndProduct(page, bobHost.url, productServer.url);
      const underBob = expectOk(
        await product.evaluate((c) => window.__TEST_PRODUCT__.deriveEntropy(c), context),
      ).entropyHex;
      // Each session mints its own root entropy source from the signer's key.
      expect(underBob).not.toBe(underAlice);
    } finally {
      await bobHost.close();
    }
  });
});

// ── Resource allocation ────────────────────────────────────────────

test.describe('Resource allocation', () => {

  test('every requested resource is allocated', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.requestResourceAllocation([
            { tag: 'StatementStoreAllowance', value: undefined },
            { tag: 'BulletinAllowance', value: undefined },
            { tag: 'SmartContractAllowance', value: { tag: 'Index', value: 0 } },
            { tag: 'AutoSigning', value: undefined },
          ]),
        ),
      );
      expect(result.outcomes).toEqual(['Allocated', 'Allocated', 'Allocated', 'Allocated']);
    } finally {
      await host.close();
    }
  });
});

// ── Feature check ──────────────────────────────────────────────────

test.describe('Feature check', () => {

  test('chain feature returns true for a configured genesis', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Default chain is PASEO_ASSET_HUB. Read the genesis from the config
      // rather than repeating the literal, so a chain reset only needs one edit.
      const result = expectOk(
        await product.evaluate(
          (genesis) => window.__TEST_PRODUCT__.featureSupported(genesis),
          PASEO_ASSET_HUB.genesisHash,
        ),
      );
      expect(result.supported).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('chain feature returns false for an unknown genesis', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(
          (genesis) => window.__TEST_PRODUCT__.featureSupported(genesis),
          `0x${'00'.repeat(32)}`,
        ),
      );
      expect(result.supported).toBe(false);
    } finally {
      await host.close();
    }
  });

  test('chain feature returns true for the People chain the host advertises', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // The People loopback is served in-page and is never in `networks`, so
      // the host used to advertise it through `supportedChains()` and then
      // deny it here — about the one chain it genuinely serves, and the one
      // every signature travels over.
      const result = expectOk(
        await product.evaluate(
          (genesis) => window.__TEST_PRODUCT__.featureSupported(genesis),
          u8aToHex(PEOPLE_GENESIS_HASH),
        ),
      );
      expect(result.supported).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('an override flips a chain feature the host would otherwise support', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      const probe = () =>
        product.evaluate(
          (genesis) => window.__TEST_PRODUCT__.featureSupported(genesis),
          PASEO_ASSET_HUB.genesisHash,
        );

      expect(expectOk(await probe()).supported).toBe(true);
      await page.evaluate(() => window.__TEST_HOST__.setFeatureSupport('Chain', false));
      expect(expectOk(await probe()).supported).toBe(false);
    } finally {
      await host.close();
    }
  });
});

// ── Local storage ──────────────────────────────────────────────────

test.describe('Local storage', () => {

  test('write, read, and clear', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('test-key', 'hello')),
      );

      const read = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageRead('test-key')),
      );
      expect(read.value).toBe('hello');

      expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageClear('test-key')),
      );

      const afterClear = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageRead('test-key')),
      );
      expect(afterClear.value).toBeNull();
    } finally {
      await host.close();
    }
  });

  test('an entry is addressable by the key the product itself used', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // A local key containing `:` is what makes suffix matching ambiguous.
      expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('demo:mykey', 'hello')),
      );

      expect(
        await page.evaluate(() => window.__TEST_HOST__.getProductStorageValue('demo:mykey')),
      ).toBe('hello');
      expect(
        await page.evaluate(() => window.__TEST_HOST__.getProductStorageValue('mykey')),
      ).toBeUndefined();

      const entries = await page.evaluate(() => window.__TEST_HOST__.getProductStorageEntries());
      expect(entries).toHaveLength(1);
      expect(entries[0].localKey).toBe('demo:mykey');
      expect(entries[0].value).toBe('hello');
      // The namespaced key is still there, and is what `seedProductStorage` takes.
      expect(entries[0].key).toContain('test-product.dot');
      expect(entries[0].key).not.toBe('demo:mykey');
    } finally {
      await host.close();
    }
  });

  test('a product resumes from a snapshot the test seeded back verbatim', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('resume-token', 'abc')),
      );

      // Round-trip only: the core namespaces productStorage keys per product,
      // so a key is never constructed by hand — only replayed as reported.
      const snapshot = await page.evaluate(() => window.__TEST_HOST__.getProductStorage());
      await page.evaluate(() => window.__TEST_HOST__.clearProductStorage());
      for (const [key, value] of Object.entries(snapshot)) {
        await page.evaluate((args) => window.__TEST_HOST__.seedProductStorage(args.key, args.value), { key, value });
      }

      const read = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.localStorageRead('resume-token')),
      );
      expect(read.value).toBe('abc');
    } finally {
      await host.close();
    }
  });

  test('a subscription replays the current value, then every later change', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('watched', 'one')));
      await product.evaluate(() => window.__TEST_PRODUCT__.subscribeLocalStorage('watched'));
      await expectStorageItems(product, ['one']);

      expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('watched', 'two')));
      await expectStorageItems(product, ['one', 'two']);

      // A clear arrives as an absent value rather than ending the stream.
      expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.localStorageClear('watched')));
      await expectStorageItems(product, ['one', 'two', null]);
    } finally {
      await host.close();
    }
  });

  test('a subscription opens on a miss with no value', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => window.__TEST_PRODUCT__.subscribeLocalStorage('never-written'));
      await expectStorageItems(product, [null]);
    } finally {
      await host.close();
    }
  });

  test('a subscription sees what the TEST seeded, not only what the product wrote', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Round-trip, as above: the namespaced key is only ever replayed.
      expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('seeded', 'first')));
      const [key] = Object.keys(await page.evaluate(() => window.__TEST_HOST__.getProductStorage()));

      await product.evaluate(() => window.__TEST_PRODUCT__.subscribeLocalStorage('seeded'));
      await expectStorageItems(product, ['first']);

      await page.evaluate((k) => window.__TEST_HOST__.seedProductStorage(k, 'second'), key);
      await expectStorageItems(product, ['first', 'second']);

      await page.evaluate(() => window.__TEST_HOST__.clearProductStorage());
      await expectStorageItems(product, ['first', 'second', null]);
    } finally {
      await host.close();
    }
  });
});

// ── Account switching, observed from the product ────────────────────

test.describe('Account switching', () => {

  // `switchAccount` deliberately does not reload the iframe, which reads like
  // the product cannot notice. It can: the core pushes the drop and the
  // reconnect down the product's own account subscription.
  test('a switch reaches a subscribed product as Disconnected then Connected', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice', 'bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => window.__TEST_PRODUCT__.subscribeAccountStatus());
      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedAccountStatus()))
        .toEqual(['Connected']);

      await page.evaluate(() => window.__TEST_HOST__.switchAccount('bob'));

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedAccountStatus()))
        .toEqual(['Connected', 'Disconnected', 'Connected']);
    } finally {
      await host.close();
    }
  });

  test('the product keeps working after a switch, with no reload', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice', 'bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await page.evaluate(() => window.__TEST_HOST__.switchAccount('bob'));

      // No page.reload() anywhere: the same frame signs under the new identity.
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x0102'),
        ),
      );
    } finally {
      await host.close();
    }
  });

  // The trap behind "a test just hangs": the host's own view of the product
  // connection only moves when a frame arrives, and a switch sends none.
  test('getConnectionStatus stays disconnected until the product next talks', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice', 'bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await page.evaluate(() => window.__TEST_HOST__.switchAccount('bob'));

      // The host session is up; only the product-traffic flag is not.
      expect(await page.evaluate(() => window.__TEST_HOST__.getChainStatus())).toBe('connected');
      expect(await page.evaluate(() => window.__TEST_HOST__.getConnectionStatus())).toBe(
        'disconnected',
      );

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x0102'),
        ),
      );
      expect(await page.evaluate(() => window.__TEST_HOST__.getConnectionStatus())).toBe(
        'connected',
      );
    } finally {
      await host.close();
    }
  });
});

// ── Resource allocation and signing observability ───────────────────

test.describe('Resource allocation policy', () => {
  /** The reporter's sequence: clear every log, sign, then read all three back. */
  async function signAndReadLogs(page: Page, product: Frame) {
    await page.evaluate(() => {
      window.__TEST_HOST__.clearSigningLog();
      window.__TEST_HOST__.clearUserConfirmationLog();
      window.__TEST_HOST__.clearPermissionLog();
    });
    const signed = expectOk(
      await product.evaluate(() =>
        window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x0102'),
      ),
    );
    const logs = await page.evaluate(() => ({
      signing: window.__TEST_HOST__.getSigningLog().map((entry) => entry.type),
      confirmation: window.__TEST_HOST__.getUserConfirmationLog().map((entry) => entry.tag),
    }));
    return { signed, logs };
  }

  const allocate = (product: Frame, tags: string[]) =>
    product.evaluate(
      (names) =>
        window.__TEST_PRODUCT__.requestResourceAllocation(
          names.map((tag) => ({ tag })) as never,
        ),
      tags,
    );

  // Documents the trap rather than asserting it is fine: a product holding
  // AutoSigning is signed for inside the core, so the host sees nothing.
  test('granting AutoSigning makes signing invisible to the host', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const before = await signAndReadLogs(page, product);
      expect(before.logs.signing).toEqual(['raw']);

      expectOk(await allocate(product, ['AutoSigning']));

      const after = await signAndReadLogs(page, product);
      // The signature is real; the host simply never saw the request.
      expect(after.signed.signature).toMatch(/^0x[0-9a-f]+$/);
      expect(after.logs).toEqual({ signing: [], confirmation: [] });
    } finally {
      await host.close();
    }
  });

  test('withholding AutoSigning keeps every signature in the signing log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      behaviors: { resourceAllocation: { AutoSigning: false } },
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const outcomes = expectOk(await allocate(product, ['AutoSigning', 'StatementStoreAllowance']));
      // Selective: the allowance a product needs is still granted.
      expect(outcomes.outcomes).toEqual(['Rejected', 'Allocated']);

      const { signed, logs } = await signAndReadLogs(page, product);
      expect(signed.signature).toMatch(/^0x[0-9a-f]+$/);
      expect(logs).toEqual({ signing: ['raw'], confirmation: ['SignRaw'] });
    } finally {
      await host.close();
    }
  });

  test('a withheld AutoSigning grant leaves authorized statement proofs working', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      behaviors: { resourceAllocation: { AutoSigning: false } },
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      expectOk(await allocate(product, ['StatementStoreAllowance']));

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.statementCreateProofAuthorized('0xaabb'),
        ),
      );
    } finally {
      await host.close();
    }
  });

  // Two gates sit in front of an allocation, and they behave differently.
  // The confirmation is all-or-nothing and fails the product's whole request;
  // the resource behavior answers per resource with a well-formed outcome.
  test('denying the ResourceAllocation confirmation fails the whole request', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(() =>
        window.__TEST_HOST__.setUserConfirmationBehavior(
          (review) => review.tag !== 'ResourceAllocation',
        ),
      );

      const refused = await allocate(product, ['AutoSigning']);
      expect(refused.ok).toBe(false);

      // And with the grant never made, signing is observable again — the same
      // outcome as `resourceAllocation`, reached through the older lever.
      const { logs } = await signAndReadLogs(page, product);
      expect(logs.signing).toEqual(['raw']);
    } finally {
      await host.close();
    }
  });

  // The review names the resources, so a test can be selective at this gate too.
  test('the ResourceAllocation review carries the resources being asked for', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await allocate(product, ['AutoSigning', 'BulletinAllowance']);

      const tags = await page.evaluate(() =>
        window.__TEST_HOST__.getUserConfirmationLog().map((entry) => entry.tag),
      );
      expect(tags).toContain('ResourceAllocation');
    } finally {
      await host.close();
    }
  });

  // The core triggers `ChainSubmit` implicitly, on the business call that needs
  // it. A product may ALSO request it explicitly at connect — product-sdk's
  // signer does, by default — which this test product deliberately does not, so
  // what is pinned here is the core's own timing.
  test('the core requests ChainSubmit on the signing call, not at connect', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expect(await page.evaluate(() => window.__TEST_HOST__.getPermissionLog())).toEqual([]);

      expectOk(await allocate(product, ['StatementStoreAllowance']));
      expect(await page.evaluate(() => window.__TEST_HOST__.getPermissionLog())).toEqual([]);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x0102'),
        ),
      );
      expect(
        await page.evaluate(() => window.__TEST_HOST__.getPermissionLog().map((e) => e.tag)),
      ).toEqual(['ChainSubmit']);
    } finally {
      await host.close();
    }
  });

  // A grant the core has stored is not re-asked, so a test that revokes and
  // expects a fresh prompt is really testing whether the revoke reached the
  // core at all. Before 0.15 it did not.
  test('revoking returns the product to being asked', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      const tags = () =>
        page.evaluate(() => window.__TEST_HOST__.getPermissionLog().map((e) => e.tag));

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x01'),
        ),
      );
      expect(await tags()).toEqual(['ChainSubmit']);

      // Signing again reuses the stored grant: no second prompt.
      await page.evaluate(() => window.__TEST_HOST__.clearPermissionLog());
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x02'),
        ),
      );
      expect(await tags()).toEqual([]);

      // After a revoke it is asked again.
      await page.evaluate(async () => {
        await window.__TEST_HOST__.revokePermission('ChainSubmit');
        window.__TEST_HOST__.clearPermissionLog();
      });
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x03'),
        ),
      );
      expect(await tags()).toEqual(['ChainSubmit']);
    } finally {
      await host.close();
    }
  });

  test('a revoked permission the host then denies actually blocks the product', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x01'),
        ),
      );

      await page.evaluate(async () => {
        window.__TEST_HOST__.setPermissionBehavior('reject-all');
        await window.__TEST_HOST__.revokePermission('ChainSubmit');
        window.__TEST_HOST__.clearPermissionLog();
      });

      const refused = await product.evaluate(() =>
        window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x02'),
      );
      expect(refused.ok).toBe(false);
      expect(
        await page.evaluate(() =>
          window.__TEST_HOST__.getPermissionLog().map((e) => `${e.tag}:${e.decision}`),
        ),
      ).toEqual(['ChainSubmit:Deny']);
    } finally {
      await host.close();
    }
  });

  test('the allocation log records what was asked and what was answered', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      behaviors: { resourceAllocation: { AutoSigning: false } },
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await allocate(product, ['AutoSigning', 'BulletinAllowance']);

      const log = await page.evaluate(() => window.__TEST_HOST__.getResourceAllocationLog());
      expect(log.map((entry) => [entry.resource, entry.granted])).toEqual([
        ['AutoSigning', false],
        ['BulletinAllowance', true],
      ]);
      expect(log[0].productId).toBe('test-product.dot');

      await page.evaluate(() => window.__TEST_HOST__.clearResourceAllocationLog());
      expect(await page.evaluate(() => window.__TEST_HOST__.getResourceAllocationLog())).toEqual([]);
    } finally {
      await host.close();
    }
  });

});

// ── Statement store ─────────────────────────────────────────────────

test.describe('Statement store', () => {
  const TOPIC = `0x${'11'.repeat(32)}` as const;
  const OTHER_TOPIC = `0x${'22'.repeat(32)}` as const;

  /** The data of every statement the product has been delivered, in order. */
  async function receivedData(product: Frame): Promise<Array<string | undefined>> {
    const pages = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedStatements());
    return pages.flatMap((page) => page.data);
  }

  test('a submitted statement is recorded and reaches a live subscriber', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate((t) => window.__TEST_PRODUCT__.subscribeStatements(t), TOPIC);
      expectOk(
        await product.evaluate(
          (t) => window.__TEST_PRODUCT__.statementSubmit(t, '0xcafe'),
          TOPIC,
        ),
      );

      await expect.poll(() => receivedData(product)).toEqual(['0xcafe']);

      const submitted = await page.evaluate(() => window.__TEST_HOST__.getSubmittedStatements());
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({ topics: [TOPIC], data: '0xcafe', fromProduct: true });
      // Submitted through `createProofAuthorized`, so it carries a real proof.
      expect(submitted[0].proof?.signature).toMatch(/^0x[0-9a-f]{128}$/);
    } finally {
      await host.close();
    }
  });

  // The regression this whole surface exists for: a test that seeds before the
  // product subscribes must not lose the statement to the race.
  test('an injected statement is replayed to a subscription opened afterwards', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(
        (t) => window.__TEST_HOST__.injectStatement({ topics: [t], data: '0xdead' }),
        TOPIC,
      );

      // Subscribed only now — the statement is already in the store.
      await product.evaluate((t) => window.__TEST_PRODUCT__.subscribeStatements(t), TOPIC);
      await expect.poll(() => receivedData(product)).toEqual(['0xdead']);
    } finally {
      await host.close();
    }
  });

  test('an injected statement reaches a subscriber already listening', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate((t) => window.__TEST_PRODUCT__.subscribeStatements(t), TOPIC);
      await page.evaluate(
        (t) => window.__TEST_HOST__.injectStatement({ topics: [t], data: '0xbeef' }),
        TOPIC,
      );

      await expect.poll(() => receivedData(product)).toEqual(['0xbeef']);
    } finally {
      await host.close();
    }
  });

  test('a statement on another topic is not delivered', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate((t) => window.__TEST_PRODUCT__.subscribeStatements(t), TOPIC);
      await page.evaluate(
        (t) => window.__TEST_HOST__.injectStatement({ topics: [t], data: '0xf00d' }),
        OTHER_TOPIC,
      );
      await page.evaluate(
        (t) => window.__TEST_HOST__.injectStatement({ topics: [t], data: '0xbeef' }),
        TOPIC,
      );

      // The matching one arrives; the other never does, whatever the ordering.
      await expect.poll(() => receivedData(product)).toEqual(['0xbeef']);
      expect(await page.evaluate(() => window.__TEST_HOST__.getStatements())).toHaveLength(2);
    } finally {
      await host.close();
    }
  });

  test('the host\'s own signing traffic stays out of the statement log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Signing is an SSO round trip over this very store.
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x0102'),
        ),
      );

      expect(await page.evaluate(() => window.__TEST_HOST__.getStatements())).toEqual([]);
      // The signature itself did happen — it is just not statement-log traffic.
      expect(await page.evaluate(() => window.__TEST_HOST__.getSigningLog())).not.toHaveLength(0);
    } finally {
      await host.close();
    }
  });

  test('clearStatements empties the log and leaves signing working', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(
        (t) => window.__TEST_HOST__.injectStatement({ topics: [t], data: '0xdead' }),
        TOPIC,
      );
      expect(await page.evaluate(() => window.__TEST_HOST__.getStatements())).toHaveLength(1);

      await page.evaluate(() => window.__TEST_HOST__.clearStatements());
      expect(await page.evaluate(() => window.__TEST_HOST__.getStatements())).toEqual([]);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x0304'),
        ),
      );
    } finally {
      await host.close();
    }
  });
});

// ── Pending operations ──────────────────────────────────────────────

test.describe('Pending operations', () => {

  test('an operation is recorded open, then closed, and reaches the host log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      // `worker.beginOperation` is reached only through the Worker protocol
      // trait, so no other execution kind can call it.
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expect(await page.evaluate(() => window.__TEST_HOST__.getOpenOperations())).toEqual([]);

      const { id } = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.beginOperation('indexing')),
      );

      const open = await page.evaluate(() => window.__TEST_HOST__.getOpenOperations());
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ id, label: 'indexing', endedAt: undefined });
      expect(open[0].productId).toBe('test-product.dot');

      expectOk(await product.evaluate((n) => window.__TEST_PRODUCT__.endOperation(n), id));

      expect(await page.evaluate(() => window.__TEST_HOST__.getOpenOperations())).toEqual([]);
      const log = await page.evaluate(() => window.__TEST_HOST__.getOperationLog());
      expect(log).toHaveLength(1);
      expect(typeof log[0].endedAt).toBe('number');
    } finally {
      await host.close();
    }
  });

  test('ending an operation twice is accepted', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const { id } = expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.beginOperation()));
      expectOk(await product.evaluate((n) => window.__TEST_PRODUCT__.endOperation(n), id));
      expectOk(await product.evaluate((n) => window.__TEST_PRODUCT__.endOperation(n), id));

      expect(await page.evaluate(() => window.__TEST_HOST__.getOperationLog())).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test('clearOperationLog leaves an open operation endable', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      executionKind: 'Worker',
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const { id } = expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.beginOperation('keep')));
      await page.evaluate(() => window.__TEST_HOST__.clearOperationLog());

      expect(await page.evaluate(() => window.__TEST_HOST__.getOperationLog())).toEqual([]);
      expect(await page.evaluate(() => window.__TEST_HOST__.getOpenOperations())).toHaveLength(1);

      expectOk(await product.evaluate((n) => window.__TEST_PRODUCT__.endOperation(n), id));
      expect(await page.evaluate(() => window.__TEST_HOST__.getOpenOperations())).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

// ── Signing ────────────────────────────────────────────────────────

test.describe('Sign raw', () => {

  test('signs a raw payload locally with no network', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const payload = `0x${'11'.repeat(16)}`;
      // The signature is a round trip through the worker and back over the SSO
      // channel, so it is awaited rather than read off a synchronous call.
      const result = expectOk(
        await product.evaluate(
          (p) => window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, p),
          payload,
        ),
      );
      expect(result.signature).toMatch(/^0x[0-9a-f]{128}$/);

      // The signer is the product's subtree soft-derived at index_bytes(0) —
      // the same key the core reports for this handle. `Product account
      // derivation` above checks that equality against the reported address
      // itself; this pins the derivation path.
      const signer = deriveSoft(deriveFromUri('//Alice//test-product.dot'), indexBytes(0))
        .publicKey;
      expect(
        verify(watermarked(hexToU8a(payload)), hexToU8a(result.signature), signer),
      ).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getSigningLog());
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe('raw');
    } finally {
      await host.close();
    }
  });

  test('signs for the session identity when named as a legacy account', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const payload = `0x${'22'.repeat(8)}`;
      const alice = deriveDev('Alice');
      const result = expectOk(
        await product.evaluate(
          ({ signer, p }) => window.__TEST_PRODUCT__.signRawLegacy(signer, p),
          { signer: u8aToHex(alice.publicKey), p: payload },
        ),
      );
      expect(verify(watermarked(hexToU8a(payload)), hexToU8a(result.signature), alice.publicKey)).toBe(
        true,
      );
    } finally {
      await host.close();
    }
  });

  test('refuses a legacy account the session does not hold', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      // One paired identity per session: the session is minted for the FIRST
      // account, so a request naming Bob is refused by design.
      accounts: ['alice', 'bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(
        (signer) => window.__TEST_PRODUCT__.signRawLegacy(signer, '0x2222'),
        u8aToHex(deriveDev('Bob').publicKey),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The core refuses before the request ever leaves for the wallet:
      // `classify_legacy_address_signer` checks the named account against the
      // active session and answers with `LEGACY_ACCOUNT_UNAVAILABLE_REASON`
      // (`truapi-server/src/runtime.rs`). The responder's own guard is a
      // backstop that is never reached on this path.
      expect(result.error).toContain('Account is not available in the active session');
    } finally {
      await host.close();
    }
  });

  test('clearSigningLog empties the log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x1234'),
        ),
      );
      expect(await page.evaluate(() => window.__TEST_HOST__.getSigningLog())).toHaveLength(1);

      await page.evaluate(() => window.__TEST_HOST__.clearSigningLog());
      expect(await page.evaluate(() => window.__TEST_HOST__.getSigningLog())).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

test.describe('Create transaction', () => {

  test('createTransaction returns a valid v4 signed extrinsic', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.createTransaction('test-product.dot', 0),
        ),
      );

      // wire layout: [compact len][0x84][0x00 + 32B pubkey][0x01 + 64B sig][0 extras][2B callData]
      const tx = decodeSignedExtrinsic(result.signedHex);
      expect(tx.bytes.length).toBe(tx.innerLength);
      expect(tx.bytes.length).toBe(1 + 1 + 32 + 1 + 64 + 2);
      expect(tx.version).toBe(0x84); // v4 + signed bit
      expect(tx.addressType).toBe(0x00); // MultiAddress::Id
      expect(tx.signatureType).toBe(0x01); // MultiSignature::Sr25519
      expect(Array.from(tx.callData)).toEqual([0, 0]);
      expect(u8aToHex(tx.signer)).toBe(
        u8aToHex(deriveSoft(deriveFromUri('//Alice//test-product.dot'), indexBytes(0)).publicKey),
      );

      // signing payload = callData || extras || additionalSigned; here just callData
      expect(verify(tx.callData, tx.signature, tx.signer)).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getSigningLog());
      expect(log.map((entry) => entry.type)).toEqual(['createTransaction']);
    } finally {
      await host.close();
    }
  });

  test('createTransactionWithLegacyAccount signs with the session identity', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      const bob = deriveDev('Bob');

      const result = expectOk(
        await product.evaluate(
          (signer) => window.__TEST_PRODUCT__.createTransactionLegacy(signer),
          u8aToHex(bob.publicKey),
        ),
      );

      const tx = decodeSignedExtrinsic(result.signedHex);
      expect(tx.bytes.length).toBe(tx.innerLength);
      expect(tx.version).toBe(0x84);
      expect(tx.addressType).toBe(0x00);
      expect(tx.signatureType).toBe(0x01);
      expect(u8aToHex(tx.signer)).toBe(u8aToHex(bob.publicKey));
      expect(verify(tx.callData, tx.signature, bob.publicKey)).toBe(true);
    } finally {
      await host.close();
    }
  });
});

test.describe('Account create proof', () => {

  test('accountCreateProof returns proof bytes bound to the account', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.accountCreateProof('test-product.dot', 0),
        ),
      );
      expect(result.proofHex).toMatch(/^0x[0-9a-f]{128}$/);
      // The alias travels with the proof and matches what getAccountAlias reports.
      const alias = expectOk(
        await product.evaluate(() => window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0)),
      );
      expect(result.alias).toBe(alias.alias);
    } finally {
      await host.close();
    }
  });
});

test.describe('Statement store proof', () => {

  test('createProofAuthorized signs with the allocated allowance slot', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // The authorized path signs with the pre-allocated allowance account, so
      // the allowance has to exist before the proof is asked for.
      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.requestResourceAllocation([
            { tag: 'StatementStoreAllowance', value: undefined },
          ]),
        ),
      );

      const result = expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.statementCreateProofAuthorized('0xdeadbeef'),
        ),
      );
      expect(result.proof.tag).toBe('Sr25519');
      if (result.proof.tag === 'OnChain') return;
      expect(result.proof.value.signature).toMatch(/^0x[0-9a-f]{128}$/);
      expect(result.proof.value.signer).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      await host.close();
    }
  });
});

// ── Session and connection state ───────────────────────────────────

test.describe('Session and connection state', () => {

  test('the host session activates and the product reports connected', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Two independent readouts: the host's own session, and the product's
      // connection. `waitForConnection` gates on the latter.
      expect(await page.evaluate(() => window.__TEST_HOST__.getChainStatus())).toBe('connected');
      expect(await page.evaluate(() => window.__TEST_HOST__.getConnectionStatus())).toBe('connected');
      expect(await product.evaluate(() => window.__TEST_PRODUCT__.connectionStatus())).toBe(
        'connected',
      );
    } finally {
      await host.close();
    }
  });

  test('an account switch re-mints the session under the new signer', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const payload = `0x${'33'.repeat(8)}`;
      const underAlice = expectOk(
        await product.evaluate(
          (p) => window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, p),
          payload,
        ),
      );

      await page.evaluate(() => window.__TEST_HOST__.switchAccount('bob'));
      await page.waitForFunction(() => window.__TEST_HOST__.getChainStatus() === 'connected', {
        timeout: 30_000,
      });

      // The iframe is deliberately NOT reloaded — its MessagePort is
      // transferred exactly once — so the same product instance keeps talking
      // over the same channel, now against Bob's session.
      const underBob = expectOk(
        await product.evaluate(
          (p) => window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, p),
          payload,
        ),
      );

      expect(underBob.signature).not.toBe(underAlice.signature);
      const signed = watermarked(hexToU8a(payload));
      expect(
        verify(
          signed,
          hexToU8a(underAlice.signature),
          deriveSoft(deriveFromUri('//Alice//test-product.dot'), indexBytes(0)).publicKey,
        ),
      ).toBe(true);
      expect(
        verify(
          signed,
          hexToU8a(underBob.signature),
          deriveSoft(deriveFromUri('//Bob//test-product.dot'), indexBytes(0)).publicKey,
        ),
      ).toBe(true);

      // The signing log survives the switch: both signatures are on it.
      const log = await page.evaluate(() => window.__TEST_HOST__.getSigningLog());
      expect(log.map((entry) => entry.type)).toEqual(['raw', 'raw']);
    } finally {
      await host.close();
    }
  });

  test('switching to a custom account signs with its configured URI', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      // The roster: Alice is the active identity, `Derived` is a switch target
      // whose URI is not derivable from its name.
      accounts: ['alice', { name: 'Derived', uri: '//Alice//custom' }],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(() => window.__TEST_HOST__.switchAccount('Derived'));
      await page.waitForFunction(() => window.__TEST_HOST__.getChainStatus() === 'connected', {
        timeout: 30_000,
      });

      const payload = `0x${'44'.repeat(8)}`;
      const signed = expectOk(
        await product.evaluate(
          (p) => window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, p),
          payload,
        ),
      );

      // The name is resolved against the configured roster, so the signer is
      // the subtree under `//Alice//custom` — NOT the `//Derived` the display
      // name alone would have produced.
      expect(
        verify(
          watermarked(hexToU8a(payload)),
          hexToU8a(signed.signature),
          deriveSoft(
            deriveFromUri('//Alice//custom//test-product.dot'),
            indexBytes(0),
          ).publicKey,
        ),
      ).toBe(true);
      expect(
        verify(
          watermarked(hexToU8a(payload)),
          hexToU8a(signed.signature),
          deriveSoft(deriveFromUri('//Derived//test-product.dot'), indexBytes(0)).publicKey,
        ),
      ).toBe(false);
    } finally {
      await host.close();
    }
  });

  /**
   * The core resolves a session username only from the dotNS contracts on
   * Asset Hub; a host without a reachable one must mint it, or `getUserId`
   * has nothing to answer.
   */
  test('getUserId reports the active account username, across a switch', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice', 'bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expect(
        expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.getUserId())).primaryUsername,
      ).toBe('alice.01');

      await page.evaluate(() => window.__TEST_HOST__.switchAccount('bob'));
      await page.waitForFunction(() => window.__TEST_HOST__.getChainStatus() === 'connected', {
        timeout: 30_000,
      });

      expect(
        expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.getUserId())).primaryUsername,
      ).toBe('bob.01');
    } finally {
      await host.close();
    }
  });

  test('a configured username overrides the derived one', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: [{ name: 'Alice', uri: '//Alice', username: 'zaphod.07' }],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expect(
        expectOk(await product.evaluate(() => window.__TEST_PRODUCT__.getUserId())).primaryUsername,
      ).toBe('zaphod.07');
    } finally {
      await host.close();
    }
  });
});

test.describe('User confirmation', () => {

  test('a rejected confirmation fails the product call', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      await page.evaluate(() => window.__TEST_HOST__.setUserConfirmationBehavior('reject-all'));

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x00'),
      );

      expect(result.ok).toBe(false);
      const log = await page.evaluate(() => window.__TEST_HOST__.getUserConfirmationLog());
      expect(log.some((entry) => entry.approved === false)).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('clearUserConfirmationLog empties the log', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expectOk(
        await product.evaluate(() =>
          window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x00'),
        ),
      );
      expect(
        await page.evaluate(() => window.__TEST_HOST__.getUserConfirmationLog()),
      ).not.toEqual([]);

      await page.evaluate(() => window.__TEST_HOST__.clearUserConfirmationLog());
      expect(await page.evaluate(() => window.__TEST_HOST__.getUserConfirmationLog())).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

// ── Initial configuration ─────────────────────────────────────────

test.describe('Initial configuration', () => {

  test('the product boots into the configured condition', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      initialState: { locale: 'pt-BR', theme: 'dark' },
      behaviors: { userConfirmation: 'reject-all' },
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // The guard is the exact single-element list below: `toEqual([...Dark])`
      // fails if a second, later value (e.g. the pre-override default) is ever
      // delivered first. Nothing here observes the product's own boot sequence.
      await product.evaluate(() => {
        window.__THEME_SUB__ = window.__TEST_PRODUCT__.subscribeTheme();
        window.__LOCALE_SUB__ = window.__TEST_PRODUCT__.subscribeLocale();
      });

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes()))
        .toEqual([{ name: { tag: 'Default', value: undefined }, variant: 'Dark' }]);

      await expect
        .poll(() => product.evaluate(() => window.__TEST_PRODUCT__.getReceivedLocales()))
        .toEqual(['pt-BR']);

      // No `setUserConfirmationBehavior` call in this test: a rejection here
      // can only come from the initial-config behaviour applied at boot.
      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x00'),
      );
      expect(result.ok).toBe(false);
      const log = await page.evaluate(() => window.__TEST_HOST__.getUserConfirmationLog());
      expect(log.some((entry) => entry.approved === false)).toBe(true);

      await product.evaluate(() => {
        window.__THEME_SUB__.unsubscribe();
        window.__LOCALE_SUB__.unsubscribe();
      });
    } finally {
      await host.close();
    }
  });
});

declare global {
  interface Window {
    __CHAT_ROOMS_SUB__: { unsubscribe(): void };
    __CHAT_ACTIONS_SUB__: { unsubscribe(): void };
    __THEME_SUB__: { unsubscribe(): void };
    __LOCALE_SUB__: { unsubscribe(): void };
  }
}
