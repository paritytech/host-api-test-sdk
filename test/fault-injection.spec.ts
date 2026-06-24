/**
 * E2E: transport fault injection.
 *
 * Drives the fault scenarios from the fault layer against the real
 * host-container ↔ product-sdk protocol (the same test product as
 * integration.spec.ts). Proves the faults change observable behaviour:
 *   - droppedHandshake → the product never connects (the #200 repro)
 *   - latency          → the product still connects (correctness preserved)
 *   - setFaults        → runtime toggle round-trips
 *
 * The test product writes 'connected' into #status once
 * getProductAccount() resolves; it stays 'loading' until then.
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHostServer, FAULT_SCENARIOS } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function serveTestProduct(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = readFileSync(join(__dirname, 'test-product.html'), 'utf-8');
  const bundle = readFileSync(join(__dirname, 'test-product-bundle.js'), 'utf-8');
  const server = createServer((req, res) => {
    if (req.url?.endsWith('.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundle);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no address'));
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test('droppedHandshake: product never connects (#200 repro)', async ({ page }) => {
  const product = await serveTestProduct();
  const host = await createTestHostServer({
    productUrl: product.url,
    accounts: ['alice'],
    faults: FAULT_SCENARIOS.droppedHandshake,
  });
  try {
    await page.goto(host.url);
    await page.waitForFunction(() => !!(window as unknown as { __TEST_HOST__?: unknown }).__TEST_HOST__, {
      timeout: 30_000,
    });
    const status = page.frameLocator('#product-frame').locator('#status');
    // Give the product ample time to (fail to) connect — the handshake response
    // is swallowed, so getProductAccount() never resolves.
    await page.waitForTimeout(8_000);
    await expect(status).toHaveText('loading');
    await expect(status).not.toHaveText('connected');
  } finally {
    await host.close();
    await product.close();
  }
});

test('latency: product still connects under injected delay', async ({ page }) => {
  const product = await serveTestProduct();
  const host = await createTestHostServer({
    productUrl: product.url,
    accounts: ['alice'],
    faults: { latencyMs: 750 },
  });
  try {
    await page.goto(host.url);
    await page.waitForFunction(() => !!(window as unknown as { __TEST_HOST__?: unknown }).__TEST_HOST__, {
      timeout: 30_000,
    });
    const status = page.frameLocator('#product-frame').locator('#status');
    // Latency slows the handshake but does not break it.
    await expect(status).toHaveText('connected', { timeout: 30_000 });
  } finally {
    await host.close();
    await product.close();
  }
});

test('setFaults/getFaults round-trips at runtime', async ({ page }) => {
  const product = await serveTestProduct();
  const host = await createTestHostServer({ productUrl: product.url, accounts: ['alice'] });
  try {
    await page.goto(host.url);
    await page.waitForFunction(() => !!(window as unknown as { __TEST_HOST__?: unknown }).__TEST_HOST__, {
      timeout: 30_000,
    });
    const faults = await page.evaluate(() => {
      const h = (window as unknown as {
        __TEST_HOST__: {
          setFaults(f: unknown): void;
          getFaults(): unknown;
        };
      }).__TEST_HOST__;
      h.setFaults({ dropEveryNth: 5, latencyMs: 100 });
      return h.getFaults();
    });
    expect(faults).toEqual({ dropEveryNth: 5, latencyMs: 100 });
  } finally {
    await host.close();
    await product.close();
  }
});
