/**
 * Integration test for @parity/truapi 0.4 products.
 *
 * A 0.4 product boots via `@parity/truapi/sandbox`: it posts `truapi-ready`
 * to the parent window and expects a `truapi-init` answer carrying a
 * transferred MessagePort, then runs all protocol traffic over that port.
 * These tests verify the test host answers the handshake and serves real
 * calls (localStorage roundtrip, product-account fetch) over the port, and
 * that the container's own handshake ping reaches the product so
 * `getConnectionStatus()` — what `waitForConnection` polls — turns
 * "connected".
 */

import { test, expect } from '@playwright/test';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { createTestHostServer } from '../dist/index.js';
import { loadHost, serveProduct } from './support';

test.describe('truapi 0.4 product — MessagePort handoff', () => {
  let productServer: Awaited<ReturnType<typeof serveProduct>>;
  let host: Awaited<ReturnType<typeof createTestHostServer>>;
  let keyring: Keyring;

  test.beforeAll(async () => {
    await cryptoWaitReady();
    keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    productServer = await serveProduct('test-product-truapi.html', 'test-product-truapi-bundle.js');
    host = await createTestHostServer({
      productUrl: productServer.url,
      accounts: ['bob'],
    });
  });

  test.afterAll(async () => {
    await host?.close();
    await productServer?.close();
  });

  test('container reports the product connected', async ({ page }) => {
    await loadHost(page, host.url);
    await page.waitForFunction(
      () => window.__TEST_HOST__?.getConnectionStatus() === 'connected',
      { timeout: 15_000 },
    );
  });

  test('serves calls over the transferred MessagePort', async ({ page }) => {
    const frame = await loadHost(page, host.url);

    await expect(frame.locator('#status')).toHaveText('client-created', { timeout: 15_000 });
    await expect(frame.locator('#storage[data-ready="true"]')).toHaveText('ok:0x68656c6c6f', {
      timeout: 15_000,
    });

    // Default product-account derivation: //Bob//test-product.dot/0
    const expectedKey = u8aToHex(keyring.addFromUri('//Bob//test-product.dot/0').publicKey);
    await expect(frame.locator('#account[data-ready="true"]')).toHaveText(expectedKey, {
      timeout: 15_000,
    });
  });
});
