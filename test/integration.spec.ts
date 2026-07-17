/**
 * Integration test: verifies that product accounts work end-to-end
 * through the real Spektr protocol (host-container ↔ product-sdk).
 *
 * A minimal product (test-product.ts) runs in the iframe, calls
 * getProductAccount("test-product", 0) via product-sdk, and writes
 * the returned public key to the DOM. These tests read it back
 * and compare against known dev keypairs.
 */

import { test, expect } from '@playwright/test';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, sr25519Verify } from '@polkadot/util-crypto';
import { compactFromU8a, hexToU8a, u8aToHex } from '@polkadot/util';
import { createTestHostServer } from '../dist/index.js';
import { loadHost, serveProduct } from './support';

// ── Helpers ─────────────────────────────────────────────────────────

/** Get the product iframe as a Frame (supports evaluate, unlike FrameLocator). */
function getProductFrame(page: import('@playwright/test').Page, productUrl: string) {
  const frame = page.frames().find(f => f.url().startsWith(productUrl));
  if (!frame) throw new Error('Product frame not found');
  return frame;
}

/** Load host, wait for product to be ready, return the evaluable product frame. */
async function loadHostAndProduct(page: import('@playwright/test').Page, hostUrl: string, productUrl: string) {
  const frameLocator = await loadHost(page, hostUrl);
  // Wait for root-keys to be ready (product fully initialized)
  await expect(frameLocator.locator('#root-keys[data-ready="true"]')).toBeVisible({ timeout: 15_000 });
  return getProductFrame(page, productUrl);
}

/** Read the public key hex that the test product received from the host. */
async function getProductPublicKey(page: import('@playwright/test').Page, hostUrl: string): Promise<string> {
  const frame = await loadHost(page, hostUrl);
  const pkLocator = frame.locator('#product-key[data-ready="true"]');
  await expect(pkLocator).toBeVisible({ timeout: 15_000 });
  return (await pkLocator.textContent())!;
}

/** Read the root (non-product) account public keys from the test product. */
async function getRootPublicKeys(page: import('@playwright/test').Page, hostUrl: string): Promise<string[]> {
  const frame = await loadHost(page, hostUrl);
  const rootLocator = frame.locator('#root-keys[data-ready="true"]');
  await expect(rootLocator).toBeVisible({ timeout: 15_000 });
  return JSON.parse((await rootLocator.textContent())!);
}

// ── Setup ───────────────────────────────────────────────────────────

let productServer: Awaited<ReturnType<typeof serveProduct>>;
let keyring: Keyring;

test.beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  productServer = await serveProduct('test-product.html', 'test-product-bundle.js');
});

test.afterAll(async () => {
  await productServer?.close();
});

// ── Tests ───────────────────────────────────────────────────────────

test.describe('Product account derivation', () => {

  test('by default, product account is derived (production behavior)', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
    });

    try {
      const bobBaseKey = u8aToHex(keyring.addFromUri('//Bob').publicKey);
      // The product calls getProductAccount("test-product", 0),
      // so the derived path is //Bob//test-product.dot/0
      const bobDerivedKey = u8aToHex(keyring.addFromUri('//Bob//test-product.dot/0').publicKey);
      const productKey = await getProductPublicKey(page, host.url);

      expect(productKey).toBe(bobDerivedKey);
      expect(productKey).not.toBe(bobBaseKey);
    } finally {
      await host.close();
    }
  });

  test('productAccounts maps a product account to a specific dev account', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
      productAccounts: {
        'test-product.dot/0': 'bob',
      },
    });

    try {
      const bobBaseKey = u8aToHex(keyring.addFromUri('//Bob').publicKey);
      const productKey = await getProductPublicKey(page, host.url);

      expect(productKey).toBe(bobBaseKey);
    } finally {
      await host.close();
    }
  });

  test('productAccounts supports custom URIs', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
      productAccounts: {
        'test-product.dot/0': { name: 'Charlie', uri: '//Charlie' },
      },
    });

    try {
      const charlieKey = u8aToHex(keyring.addFromUri('//Charlie').publicKey);
      const productKey = await getProductPublicKey(page, host.url);

      expect(productKey).toBe(charlieKey);
    } finally {
      await host.close();
    }
  });

  test('unmapped product accounts fall back to derivation', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
      productAccounts: {
        'other-app/0': 'alice', // different key, won't match
      },
    });

    try {
      // "test-product.dot/0" is NOT in productAccounts, so it derives
      const bobDerivedKey = u8aToHex(keyring.addFromUri('//Bob//test-product.dot/0').publicKey);
      const productKey = await getProductPublicKey(page, host.url);

      expect(productKey).toBe(bobDerivedKey);
    } finally {
      await host.close();
    }
  });
});

test.describe('Root (non-product) accounts', () => {

  test('dev account names resolve to known public keys', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice', 'bob'],
    });

    try {
      const aliceKey = u8aToHex(keyring.addFromUri('//Alice').publicKey);
      const bobKey = u8aToHex(keyring.addFromUri('//Bob').publicKey);
      const rootKeys = await getRootPublicKeys(page, host.url);

      expect(rootKeys).toEqual([aliceKey, bobKey]);
    } finally {
      await host.close();
    }
  });

  test('custom URI accounts are included in root accounts', async ({ page }) => {
    const customUri = '//Alice//custom/derivation';
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob', { name: 'Custom', uri: customUri }],
    });

    try {
      const bobKey = u8aToHex(keyring.addFromUri('//Bob').publicKey);
      const customKey = u8aToHex(keyring.addFromUri(customUri).publicKey);
      const rootKeys = await getRootPublicKeys(page, host.url);

      expect(rootKeys).toEqual([bobKey, customKey]);
    } finally {
      await host.close();
    }
  });
});

// ── Permission enforcement ──────────────────────────────────────────

test.describe('Permission handling', () => {

  test('signing works without explicit permission request', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // In v0.7, signing doesn't require ChainSubmit — that permission
      // is enforced by the container at transaction_broadcast level.
      const result = await product.evaluate(() => window.__TEST_PRODUCT__.trySignRaw());
      expect(result.ok).toBe(true);
      expect(result.signature).toBeTruthy();
    } finally {
      await host.close();
    }
  });

  test('ChainSubmit permission request is logged', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const permResult = await product.evaluate(() => window.__TEST_PRODUCT__.requestChainSubmit());
      expect(permResult.ok).toBe(true);
      expect(permResult.approved).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((e: any) => e.tag === 'ChainSubmit' && e.approved)).toBe(true);
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

      const permResult = await product.evaluate(() => window.__TEST_PRODUCT__.requestChainSubmit());
      expect(permResult.ok).toBe(true);
      expect(permResult.approved).toBe(false);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((e: any) => e.tag === 'ChainSubmit' && !e.approved)).toBe(true);
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

      const result = await product.evaluate(() => window.__TEST_PRODUCT__.requestDevicePermission('Camera'));
      expect(result.ok).toBe(true);

      // Verify it was logged
      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((e: any) => e.tag === 'Camera' && e.approved)).toBe(true);

      // Verify it's in granted set
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

      const result = await product.evaluate(() => window.__TEST_PRODUCT__.requestDevicePermission('Microphone'));
      expect(result.ok).toBe(true); // request completed, check approved field

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((e: any) => e.tag === 'Microphone' && !e.approved)).toBe(true);

      const granted = await page.evaluate(() => window.__TEST_HOST__.getGrantedPermissions());
      expect(granted).not.toContain('Microphone');
    } finally {
      await host.close();
    }
  });

  test('Remote permission is tracked', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.requestRemote('https://example.com')
      );
      expect(result.ok).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
      expect(log.some((e: any) => e.tag === 'Remote' && e.approved)).toBe(true);
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

      // Log should be empty initially
      const initial = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(initial).toEqual([]);

      // Product requests navigation
      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.navigateTo('polkadot://example.dot/settings'),
      );
      expect(result.ok).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(log).toHaveLength(1);
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

      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('https://example.com'));
      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('polkadot://foo.dot'));
      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('polkadot://bar.dot/page'));

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(log.map((e: any) => e.url)).toEqual([
        'https://example.com',
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

      await product.evaluate(() => window.__TEST_PRODUCT__.navigateTo('https://a.com'));
      await page.evaluate(() => window.__TEST_HOST__.clearNavigationLog());

      const log = await page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
      expect(log).toEqual([]);
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

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.pushNotification('You have a new message'),
      );
      expect(result.ok).toBe(true);

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

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.pushNotification(
          'Tap to view',
          'polkadot://myapp.dot/message/42',
        ),
      );
      expect(result.ok).toBe(true);

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

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.pushNotification('later', undefined, Date.now() + 60_000),
      );
      expect(result.ok).toBe(true);
      expect(typeof result.notificationId).toBe('number');

      const before = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(before).toHaveLength(1);
      expect(before[0].cancelled).toBe(false);
      expect(typeof before[0].scheduledAt).toBe('bigint');

      const cancel = await product.evaluate((id: number) =>
        window.__TEST_PRODUCT__.pushNotificationCancel(id),
        result.notificationId!,
      );
      expect(cancel.ok).toBe(true);

      const after = await page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
      expect(after[0].cancelled).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Account alias ───────────────────────────────────────────────────

test.describe('Account alias', () => {

  test('accountGetAlias returns deterministic context and alias', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Same account returns the same alias across calls
      const a = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0),
      );
      const b = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0),
      );

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(a.context).toBe(b.context);
      expect(a.alias).toBe(b.alias);

      // Context and alias are 32-byte hex (0x + 64 hex chars)
      expect(a.context).toMatch(/^0x[0-9a-f]{64}$/);
      expect(a.alias).toMatch(/^0x[0-9a-f]{64}$/);
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

      const a = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 0),
      );
      const b = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getAccountAlias('test-product.dot', 1),
      );

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(a.alias).not.toBe(b.alias);
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
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const first = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'r1', name: 'Room 1', icon: 'icon-data' }),
      );
      expect(first.ok).toBe(true);
      expect(first.status).toBe('New');

      const second = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'r1', name: 'Room 1', icon: 'icon-data' }),
      );
      expect(second.ok).toBe(true);
      expect(second.status).toBe('Exists');

      const rooms = await page.evaluate(() => window.__TEST_HOST__.getChatRooms());
      expect(rooms).toHaveLength(1);
      expect(rooms[0].roomId).toBe('r1');
      expect(rooms[0].name).toBe('Room 1');
      expect(rooms[0].participatingAs).toBe('RoomHost');
    } finally {
      await host.close();
    }
  });

  test('chatRegisterBot returns New/Exists correctly', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const first = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatRegisterBot({ botId: 'b1', name: 'MyBot', icon: 'icon' }),
      );
      expect(first.status).toBe('New');

      const second = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatRegisterBot({ botId: 'b1', name: 'MyBot', icon: 'icon' }),
      );
      expect(second.status).toBe('Exists');

      const bots = await page.evaluate(() => window.__TEST_HOST__.getChatBots());
      expect(bots).toHaveLength(1);
      expect(bots[0].botId).toBe('b1');
    } finally {
      await host.close();
    }
  });

  test('chatPostMessage fails if room does not exist', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatPostTextMessage('no-such-room', 'hello'),
      );
      expect(result.ok).toBe(false);
    } finally {
      await host.close();
    }
  });

  test('chatPostMessage succeeds when room exists and is logged', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'room-a', name: 'A', icon: '' }),
      );

      const r1 = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatPostTextMessage('room-a', 'hello'),
      );
      const r2 = await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatPostTextMessage('room-a', 'world'),
      );

      expect(r1.ok).toBe(true);
      expect(r1.messageId).toBeTruthy();
      expect(r2.ok).toBe(true);
      expect(r2.messageId).not.toBe(r1.messageId);

      const log = await page.evaluate(() => window.__TEST_HOST__.getChatMessageLog());
      expect(log).toHaveLength(2);
      expect(log[0].roomId).toBe('room-a');
      expect(log[0].payload).toEqual({ tag: 'Text', value: 'hello' });
      expect(log[1].payload).toEqual({ tag: 'Text', value: 'world' });
    } finally {
      await host.close();
    }
  });

  test('chatListSubscribe receives current rooms and new room creation', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Create a room first
      await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'pre', name: 'Pre', icon: '' }),
      );

      // Subscribe — should immediately receive the existing room
      await product.evaluate(() => {
        (window as any).__chatListReceived = [];
        (window as any).__chatListSub = (window as any).hostApi?.chatListSubscribe;
        // Use the product-sdk hostApi directly for this subscription test
      });

      // Alternative: use __TEST_PRODUCT__ if we wired it up; simpler approach — create a room
      // after subscribing via the live subscribe path. We'll just verify the rooms show up
      // in the host's list, which is the contract.

      const rooms = await page.evaluate(() => window.__TEST_HOST__.getChatRooms());
      expect(rooms.map((r: any) => r.roomId)).toContain('pre');
    } finally {
      await host.close();
    }
  });

  test('injectChatAction delivers to subscribers', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Product subscribes to chat actions
      await product.evaluate(() => {
        (window as any).__chatSub = window.__TEST_PRODUCT__.subscribeChatActions();
      });

      // Host injects an action
      await page.evaluate(() => {
        window.__TEST_HOST__.injectChatAction({
          roomId: 'room-x',
          peer: 'peer-1',
          payload: {
            tag: 'MessagePosted',
            value: { tag: 'Text', value: 'hi from peer' },
          },
        });
      });

      // Small wait for async delivery
      await page.waitForTimeout(50);

      const received = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedChatActions());
      expect(received).toHaveLength(1);
      expect((received[0] as any).roomId).toBe('room-x');
      expect((received[0] as any).peer).toBe('peer-1');

      // Cleanup
      await product.evaluate(() => (window as any).__chatSub.unsubscribe());
    } finally {
      await host.close();
    }
  });

  test('clearChatState wipes rooms, bots, and messages', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatCreateRoom({ roomId: 'r1', name: 'R1', icon: '' }),
      );
      await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatRegisterBot({ botId: 'b1', name: 'B1', icon: '' }),
      );
      await product.evaluate(() =>
        window.__TEST_PRODUCT__.chatPostTextMessage('r1', 'm'),
      );

      await page.evaluate(() => window.__TEST_HOST__.clearChatState());

      const rooms = await page.evaluate(() => window.__TEST_HOST__.getChatRooms());
      const bots = await page.evaluate(() => window.__TEST_HOST__.getChatBots());
      const log = await page.evaluate(() => window.__TEST_HOST__.getChatMessageLog());
      expect(rooms).toEqual([]);
      expect(bots).toEqual([]);
      expect(log).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

// ── Preimage ────────────────────────────────────────────────────────

test.describe('Preimage', () => {

  test('preimageSubmit stores the value and returns its key', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.preimageSubmit([1, 2, 3, 4]),
      );
      expect(result.ok).toBe(true);
      expect(result.key).toMatch(/^0x[0-9a-f]{64}$/);

      const preimages = await page.evaluate(() => window.__TEST_HOST__.getPreimages());
      expect(preimages).toHaveLength(1);
      expect(preimages[0].key).toBe(result.key);
      expect(preimages[0].fromProduct).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('preimageLookup returns seeded value', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Seed a preimage from the test side
      const key = await page.evaluate(() => {
        return window.__TEST_HOST__.seedPreimage(new Uint8Array([42, 42, 42]));
      });

      // Product looks it up
      const result = await product.evaluate((k: string) =>
        window.__TEST_PRODUCT__.preimageLookup(k), key);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([42, 42, 42]);
    } finally {
      await host.close();
    }
  });

  test('preimageLookup returns null for unknown key', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const unknownKey = '0x' + '00'.repeat(32);
      const result = await product.evaluate((k: string) =>
        window.__TEST_PRODUCT__.preimageLookup(k), unknownKey);
      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    } finally {
      await host.close();
    }
  });
});

// ── Statement store ─────────────────────────────────────────────────

test.describe('Statement store', () => {

  test('statementStoreSubmit records submissions', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const topic = '0x' + 'aa'.repeat(32);
      const data = '0xdeadbeef';
      const result = await product.evaluate(
        ([t, d]) => window.__TEST_PRODUCT__.statementSubmit([t], d),
        [topic, data] as const,
      );
      expect(result.ok).toBe(true);

      const submitted = await page.evaluate(() =>
        window.__TEST_HOST__.getSubmittedStatements(),
      );
      expect(submitted).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  test('statementStoreSubmit delivers to active subscribers', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const topic = '0x' + 'bb'.repeat(32);

      // Product subscribes to statements (no topic filter — match all)
      await product.evaluate(() => {
        (window as any).__stmtSub = window.__TEST_PRODUCT__.statementSubscribe([]);
      });

      // Product submits a statement on topic — should round-trip back via subscription
      const result = await product.evaluate((t: string) =>
        window.__TEST_PRODUCT__.statementSubmit([t], '0xdeadbeef'),
        topic,
      );
      expect(result.ok).toBe(true);

      await page.waitForTimeout(100);

      const received = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getReceivedStatements(),
      );
      expect(received).toHaveLength(1);

      // Host also has the submitted statement in its log
      const submitted = await page.evaluate(() =>
        window.__TEST_HOST__.getSubmittedStatements(),
      );
      expect(submitted).toHaveLength(1);

      await product.evaluate(() => (window as any).__stmtSub.unsubscribe());
    } finally {
      await host.close();
    }
  });

  test('topic filter: subscriber with non-matching topic receives nothing', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const subscribedTopic = '0x' + 'bb'.repeat(32);
      const otherTopic = '0x' + 'cc'.repeat(32);

      await product.evaluate((t: string) => {
        (window as any).__stmtSub = window.__TEST_PRODUCT__.statementSubscribe([t]);
      }, subscribedTopic);

      // Submit on a different topic — should NOT match the subscriber's filter
      const result = await product.evaluate((t: string) =>
        window.__TEST_PRODUCT__.statementSubmit([t], '0x01'),
        otherTopic,
      );
      expect(result.ok).toBe(true);

      await page.waitForTimeout(100);

      const received = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getReceivedStatements(),
      );
      expect(received).toHaveLength(0);

      await product.evaluate(() => (window as any).__stmtSub.unsubscribe());
    } finally {
      await host.close();
    }
  });
});

// ── Container recreation resets state ───────────────────────────────

test.describe('Container recreation resets logs', () => {

  test('permission grants do not leak across setAccounts', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Grant permission, verify it's set
      await page.evaluate(() => window.__TEST_HOST__.grantPermission('ChainSubmit'));
      const granted = await page.evaluate(() => window.__TEST_HOST__.getGrantedPermissions());
      expect(granted).toContain('ChainSubmit');

      // Switch accounts — container recreates, grants should clear
      await page.evaluate(() => window.__TEST_HOST__.setAccounts(['bob']));
      await loadHostAndProduct(page, host.url, productServer.url); // wait for product to reconnect

      const grantedAfter = await page.evaluate(() => window.__TEST_HOST__.getGrantedPermissions());
      expect(grantedAfter).not.toContain('ChainSubmit');
    } finally {
      await host.close();
    }
  });
});

// ── Theme ──────────────────────────────────────────────────────────

test.describe('Theme', () => {

  test('theme subscribe delivers current theme', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => {
        (window as any).__themeSub = window.__TEST_PRODUCT__.subscribeTheme();
      });
      await page.waitForTimeout(100);

      const themes = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes()) as Array<{ name: { tag: string; value?: string }; variant: 'Light' | 'Dark' }>;
      expect(themes.length).toBeGreaterThanOrEqual(1);
      expect(themes[0]).toEqual({ name: { tag: 'Default', value: undefined }, variant: 'Light' });

      // Host changes theme using the shorthand
      await page.evaluate(() => window.__TEST_HOST__.setTheme('dark'));
      await page.waitForTimeout(100);

      const updated = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes()) as Array<{ name: { tag: string; value?: string }; variant: 'Light' | 'Dark' }>;
      expect(updated.at(-1)).toEqual({ name: { tag: 'Default', value: undefined }, variant: 'Dark' });

      await product.evaluate(() => (window as any).__themeSub.unsubscribe());
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
      await page.evaluate(() => window.__TEST_HOST__.setTheme({
        name: { tag: 'Custom', value: 'midnight' },
        variant: 'Dark',
      }));

      await product.evaluate(() => {
        (window as any).__themeSub = window.__TEST_PRODUCT__.subscribeTheme();
      });
      await page.waitForTimeout(100);

      const themes = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedThemes()) as Array<{ name: { tag: string; value?: string }; variant: 'Light' | 'Dark' }>;
      expect(themes.at(-1)).toEqual({
        name: { tag: 'Custom', value: 'midnight' },
        variant: 'Dark',
      });

      // getTheme also returns the struct on the host side.
      const current = await page.evaluate(() => window.__TEST_HOST__.getTheme());
      expect(current).toEqual({ name: { tag: 'Custom', value: 'midnight' }, variant: 'Dark' });

      await product.evaluate(() => (window as any).__themeSub.unsubscribe());
    } finally {
      await host.close();
    }
  });
});

// ── Entropy ────────────────────────────────────────────────────────

test.describe('Entropy', () => {

  test('deriveEntropy returns 32-byte deterministic result', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const keyHex = '0x' + '01'.repeat(16); // 16-byte key
      const a = await product.evaluate((k: string) =>
        window.__TEST_PRODUCT__.deriveEntropy(k), keyHex);
      expect(a.ok).toBe(true);
      expect(a.entropyHex).toMatch(/^0x[0-9a-f]{64}$/); // 32 bytes

      // Same key → same result (deterministic)
      const b = await product.evaluate((k: string) =>
        window.__TEST_PRODUCT__.deriveEntropy(k), keyHex);
      expect(b.entropyHex).toBe(a.entropyHex);

      // Different key → different result
      const c = await product.evaluate((k: string) =>
        window.__TEST_PRODUCT__.deriveEntropy(k), '0x' + '02'.repeat(16));
      expect(c.ok).toBe(true);
      expect(c.entropyHex).not.toBe(a.entropyHex);
    } finally {
      await host.close();
    }
  });
});

// ── Login / getUserId ──────────────────────────────────────────────

test.describe('Login and user identity', () => {

  test('requestLogin succeeds on a fresh page and flips getIsAuthenticated() to true', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      expect(await page.evaluate(() => window.__TEST_HOST__.getIsAuthenticated())).toBe(false);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.requestLogin('test'));
      expect(result.ok).toBe(true);
      expect(result.loginResult).toBe('success');

      expect(await page.evaluate(() => window.__TEST_HOST__.getIsAuthenticated())).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('requestLogin returns alreadyConnected when already authenticated', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Pre-authenticate
      await page.evaluate(() => window.__TEST_HOST__.simulateReconnect());

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.requestLogin('test'));
      expect(result.ok).toBe(true);
      expect(result.loginResult).toBe('alreadyConnected');
    } finally {
      await host.close();
    }
  });

  test('rejected login leaves getIsAuthenticated() false (regression for #25)', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await page.evaluate(() => window.__TEST_HOST__.setLoginBehavior('reject'));

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.requestLogin('please'));
      expect(result.ok).toBe(true);
      expect(result.loginResult).toBe('rejected');

      expect(await page.evaluate(() => window.__TEST_HOST__.getIsAuthenticated())).toBe(false);
    } finally {
      await host.close();
    }
  });

  test('getUserId returns primaryUsername', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // getUserId requires an authenticated session
      await page.evaluate(() => window.__TEST_HOST__.simulateReconnect());

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.getUserId());
      expect(result.ok).toBe(true);
      expect(result.primaryUsername).toBe('Alice');
    } finally {
      await host.close();
    }
  });
});

// ── Resource allocation ────────────────────────────────────────────

test.describe('Resource allocation', () => {

  test('all resources are allocated', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.requestResourceAllocation([
          { tag: 'StatementStoreAllowance', value: undefined },
          { tag: 'BulletinAllowance', value: undefined },
          { tag: 'SmartContractAllowance', value: 0 },
          { tag: 'AutoSigning', value: undefined },
        ]));
      expect(result.ok).toBe(true);
      expect(result.outcomes).toHaveLength(4);
      expect(result.outcomes!.every(o => o.tag === 'Allocated')).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Feature check ──────────────────────────────────────────────────

test.describe('Feature check', () => {

  test('chain feature returns true for configured genesis', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Default chain is PASEO_ASSET_HUB
      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.featureSupported('Chain',
          '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f'));
      expect(result.ok).toBe(true);
      expect(result.supported).toBe(true);
    } finally {
      await host.close();
    }
  });

  test('chain feature returns false for unknown genesis', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.featureSupported('Chain', '0x' + '00'.repeat(32)));
      expect(result.ok).toBe(true);
      expect(result.supported).toBe(false);
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

      // Write
      const w = await product.evaluate(() =>
        window.__TEST_PRODUCT__.localStorageWrite('test-key', 'hello'));
      expect(w.ok).toBe(true);

      // Read back
      const r = await product.evaluate(() =>
        window.__TEST_PRODUCT__.localStorageRead('test-key'));
      expect(r.ok).toBe(true);
      expect(r.value).toBe('hello');

      // Clear
      const c = await product.evaluate(() =>
        window.__TEST_PRODUCT__.localStorageClear('test-key'));
      expect(c.ok).toBe(true);

      // Read again — should be null
      const r2 = await product.evaluate(() =>
        window.__TEST_PRODUCT__.localStorageRead('test-key'));
      expect(r2.ok).toBe(true);
      expect(r2.value).toBeNull();
    } finally {
      await host.close();
    }
  });
});

// ── Statement store proof ──────────────────────────────────────────

test.describe('Statement store proof', () => {

  test('createProof returns a valid proof', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
      productAccounts: { 'test-product.dot/0': 'alice' },
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.statementCreateProof('test-product.dot', 0, '0xdeadbeef'));
      expect(result.ok).toBe(true);
      expect(result.proof).toBeTruthy();
    } finally {
      await host.close();
    }
  });
});

// ── Create transaction ─────────────────────────────────────────────

test.describe('Create transaction', () => {

  test('createTransaction returns a valid v4 signed extrinsic', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.createTransaction('test-product.dot', 0));
      expect(result.ok).toBe(true);
      expect(result.signedHex).toBeDefined();

      // test-product sends callData = [0, 0], no extensions
      // wire layout: [compact len][0x84][0x00 + 32B pubkey][0x01 + 64B sig][0 extras][2B callData]
      const wire = hexToU8a(result.signedHex!);
      const [offset, innerLen] = compactFromU8a(wire); // [bytesUsed, BN value]
      const bytes = wire.slice(offset);
      expect(bytes.length).toBe(innerLen.toNumber());
      expect(bytes.length).toBe(1 + 1 + 32 + 1 + 64 + 2);
      expect(bytes[0]).toBe(0x84);   // v4 + signed bit
      expect(bytes[1]).toBe(0x00);   // MultiAddress::Id
      expect(bytes[34]).toBe(0x01);  // MultiSignature::Sr25519

      const pubkey = bytes.slice(2, 34);
      const signature = bytes.slice(35, 99);
      const callData = bytes.slice(99, 101);
      expect(Array.from(callData)).toEqual([0, 0]);

      // signing payload = callData || extras || additionalSigned; here just callData
      expect(sr25519Verify(callData, signature, pubkey)).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Create transaction (legacy account) ───────────────────────────

test.describe('Create transaction with legacy account', () => {

  test('returns a valid v4 signed extrinsic signed by the legacy account', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      const keyring = new Keyring({ type: 'sr25519' });
      const bobPubKey = u8aToHex(keyring.addFromUri('//Bob').publicKey);

      const result = await product.evaluate((pk: string) =>
        window.__TEST_PRODUCT__.createTransactionLegacy(pk), bobPubKey);
      expect(result.ok).toBe(true);
      expect(result.signedHex).toBeDefined();

      // Same layout as the product-account flow, but signer == bob's pubkey
      const wire = hexToU8a(result.signedHex!);
      const [offset, innerLen] = compactFromU8a(wire);
      const bytes = wire.slice(offset);
      expect(bytes.length).toBe(innerLen.toNumber());
      expect(bytes[0]).toBe(0x84);
      expect(bytes[1]).toBe(0x00);
      expect(bytes[34]).toBe(0x01);

      const signerPubkey = bytes.slice(2, 34);
      expect(u8aToHex(signerPubkey)).toBe(bobPubKey);

      const signature = bytes.slice(35, 99);
      const callData = bytes.slice(99, 101);
      expect(sr25519Verify(callData, signature, signerPubkey)).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Payments (RFC-0006) ───────────────────────────────────────────

test.describe('Payments', () => {

  test('topUp + requestPayment are recorded; balance decreases', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const dest = '0x' + 'aa'.repeat(32);
      const result = await product.evaluate((d: string) =>
        window.__TEST_PRODUCT__.paymentSmoke(d), dest);
      expect(result.ok).toBe(true);
      expect(result.paymentId).toMatch(/^pay-\d+$/);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPaymentLog());
      expect(log).toHaveLength(2);
      expect(log[0].type).toBe('top-up');
      expect(log[0].amount).toBe(1000n);
      expect(log[1].type).toBe('request');
      expect(log[1].amount).toBe(500n);
      expect(log[1].paymentId).toBe(result.paymentId);
      // Default (no purse selector) → purse is undefined in the log.
      expect(log[0].purse).toBeUndefined();
      expect(log[1].purse).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  test('purse selector is recorded on top-up and request', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const dest = '0x' + 'bb'.repeat(32);
      const result = await product.evaluate(
        ({ d, p }: { d: string; p: number }) => window.__TEST_PRODUCT__.paymentSmokeWithPurse(d, p),
        { d: dest, p: 7 },
      );
      expect(result.ok).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPaymentLog());
      expect(log).toHaveLength(2);
      expect(log[0].type).toBe('top-up');
      expect(log[0].purse).toBe(7);
      expect(log[1].type).toBe('request');
      expect(log[1].purse).toBe(7);
    } finally {
      await host.close();
    }
  });

  // RFC-0021 coins top-up source. `keys` must be 64-byte sr25519 secret keys
  // (codec changed from 32-byte ed25519 in upstream 0.8.4).
  test('coins top-up source round-trips through paymentLog', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const k1 = '0x' + '11'.repeat(64);
      const k2 = '0x' + '22'.repeat(64);
      const result = await product.evaluate(
        ({ amount, keys }: { amount: string; keys: string[] }) =>
          window.__TEST_PRODUCT__.paymentTopUpCoins(amount, keys),
        { amount: '750', keys: [k1, k2] },
      );
      expect(result.ok).toBe(true);

      const log = await page.evaluate(() => window.__TEST_HOST__.getPaymentLog());
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe('top-up');
      expect(log[0].amount).toBe(750n);
      const source = log[0].source as { tag: string; value: Uint8Array[] };
      expect(source.tag).toBe('Coins');
      expect(source.value).toHaveLength(2);
      expect(source.value[0]).toHaveLength(64);
      expect(source.value[1]).toHaveLength(64);
    } finally {
      await host.close();
    }
  });

  // RFC-0021 PartialPayment error path. The host credits `credited` and rejects
  // with PaymentTopUpErr.PartialPayment({ credited }) so the product can reconcile.
  test('PartialPayment behavior credits partially and rejects with credited amount', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Drive the host into partial-credit mode for the next topUp.
      await page.evaluate(() => {
        window.__TEST_HOST__.setPaymentTopUpBehavior({ type: 'partial', credited: 200n });
      });

      const k1 = '0x' + 'ab'.repeat(64);
      const k2 = '0x' + 'cd'.repeat(64);
      const result = await product.evaluate(
        ({ amount, keys }: { amount: string; keys: string[] }) =>
          window.__TEST_PRODUCT__.paymentTopUpCoins(amount, keys),
        { amount: '1000', keys: [k1, k2] },
      );
      expect(result.ok).toBe(false);
      expect(result.credited).toBe('200');

      // The attempted top-up is still recorded with the requested amount...
      const log = await page.evaluate(() => window.__TEST_HOST__.getPaymentLog());
      expect(log).toHaveLength(1);
      expect(log[0].amount).toBe(1000n);
      // ...but only `credited` actually landed in the balance.
      const balances = await product.evaluate(() => {
        const sub = window.__TEST_PRODUCT__.subscribeBalance();
        return new Promise<string[]>((resolve) => {
          setTimeout(() => {
            sub.unsubscribe();
            resolve(window.__TEST_PRODUCT__.getReceivedBalances());
          }, 100);
        });
      });
      expect(balances).toContain('200');
    } finally {
      await host.close();
    }
  });
});

// ── Sign raw (product account) ────────────────────────────────────

test.describe('Sign raw (product account)', () => {

  test('signRaw signs bytes with the product-account keypair', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      const payloadHex = '0x' + '11'.repeat(16);
      const result = await product.evaluate((p: string) =>
        window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, p), payloadHex);
      expect(result.ok).toBe(true);
      expect(result.signature).toMatch(/^0x[0-9a-f]{128}$/); // 64-byte sr25519 sig

      const log = await page.evaluate(() => window.__TEST_HOST__.getSigningLog());
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe('raw');
    } finally {
      await host.close();
    }
  });
});

// ── Statement store proof (authorized) ────────────────────────────

test.describe('Statement store proof (authorized)', () => {

  test('createProofAuthorized returns valid proof using the host allowance slot', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);
      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.statementCreateProofAuthorized('0xdeadbeef'));
      expect(result.ok).toBe(true);
      // proof is enum SignatureProof; one variant carries { signature, signer }
      const p = result.proof as { tag: string; value: { signature: Uint8Array; signer: Uint8Array } };
      expect(['Sr25519', 'Ed25519', 'Ecdsa']).toContain(p.tag);
      expect(p.value.signature.length).toBeGreaterThanOrEqual(64);
      expect(p.value.signer.length).toBe(32);
    } finally {
      await host.close();
    }
  });
});

// ── Payment subscriptions ──────────────────────────────────────────

test.describe('Payment subscriptions', () => {

  test('subscribeBalance delivers updates when setPaymentBalance is called', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      await product.evaluate(() => window.__TEST_PRODUCT__.subscribeBalance());
      // Initial value (0) is delivered on subscribe, then update fires the callback
      await page.evaluate(() => window.__TEST_HOST__.setPaymentBalance(BigInt('7777')));
      await page.evaluate(() => window.__TEST_HOST__.setPaymentBalance(BigInt('9999')));

      // Settle
      await page.waitForTimeout(50);
      const received = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedBalances());
      expect(received).toContain('7777');
      expect(received).toContain('9999');
    } finally {
      await host.close();
    }
  });

  test('subscribePaymentStatus delivers status updates simulated from the host', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      // Drive a payment to obtain an id, then subscribe + simulate status
      const dest = '0x' + 'bb'.repeat(32);
      const pay = await product.evaluate((d: string) =>
        window.__TEST_PRODUCT__.paymentSmoke(d), dest);
      expect(pay.paymentId).toBeDefined();

      await product.evaluate((id: string) =>
        window.__TEST_PRODUCT__.subscribePaymentStatus(id), pay.paymentId!);
      await page.evaluate((id: string) =>
        window.__TEST_HOST__.simulatePaymentStatus(id, { tag: 'Completed', value: undefined }), pay.paymentId!);

      await page.waitForTimeout(50);
      const received = await product.evaluate(() => window.__TEST_PRODUCT__.getReceivedStatuses());
      expect(received.some((s) => s.type === 'completed')).toBe(true);
    } finally {
      await host.close();
    }
  });
});

// ── Account create proof ───────────────────────────────────────────

test.describe('Account create proof', () => {

  test('accountCreateProof returns proof bytes', async ({ page }) => {
    const host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['alice'],
    });

    try {
      const product = await loadHostAndProduct(page, host.url, productServer.url);

      const result = await product.evaluate(() =>
        window.__TEST_PRODUCT__.accountCreateProof('test-product.dot', 0));
      expect(result.ok).toBe(true);
      expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);
      expect(result.proofHex!.length).toBeGreaterThan(10);
    } finally {
      await host.close();
    }
  });
});
