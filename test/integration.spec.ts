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
      // The core resolves the dotNS scheme before handing the URL to the host,
      // so what the host records is the https form, not what the product typed.
      expect(log[0].url).toBe('https://example.dot/settings');
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
      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('polkadot://bar.dot/page'));

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      // dotNS-resolved, in the order the product asked for them.
      expect(log.map((entry) => entry.url)).toEqual([
        'https://foo.dot',
        'https://bar.dot/page',
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
});

declare global {
  interface Window {
    __CHAT_ROOMS_SUB__: { unsubscribe(): void };
    __CHAT_ACTIONS_SUB__: { unsubscribe(): void };
    __THEME_SUB__: { unsubscribe(): void };
    __LOCALE_SUB__: { unsubscribe(): void };
  }
}
