/**
 * ESM compatibility test: verifies import works for both entry points
 * and the server functions correctly when loaded via ESM.
 * Run: node test-exports-esm.mjs
 */

import assert from 'node:assert';
import { describe, it, after } from 'node:test';

describe('ESM import("@parity/host-api-test-sdk")', () => {
  /** @type {import('./dist/index')} */
  let sdk;

  it('can be imported', async () => {
    sdk = await import('./dist/index.js');
  });

  it('exports createTestHostServer', () => {
    assert.strictEqual(typeof sdk.createTestHostServer, 'function');
  });

  it('exports DEV_ACCOUNTS', () => {
    assert.ok(sdk.DEV_ACCOUNTS);
    assert.strictEqual(sdk.DEV_ACCOUNTS.alice.name, 'Alice');
    assert.strictEqual(sdk.DEV_ACCOUNTS.bob.uri, '//Bob');
  });

  it('exports DEV_ACCOUNT_NAMES', () => {
    assert.ok(Array.isArray(sdk.DEV_ACCOUNT_NAMES));
    assert.ok(sdk.DEV_ACCOUNT_NAMES.includes('alice'));
  });

  it('exports chain configs', () => {
    assert.ok(sdk.DEFAULT_CHAIN);
    assert.ok(sdk.PASEO_ASSET_HUB);
    assert.ok(sdk.PREVIEWNET);
    assert.ok(sdk.PREVIEWNET_ASSET_HUB);
    assert.ok(Array.isArray(sdk.SUPPORTED_CHAINS));
    assert.strictEqual(sdk.DEFAULT_CHAIN, sdk.PASEO_ASSET_HUB);
  });

  describe('createTestHostServer (ESM)', () => {
    let server;

    after(async () => {
      if (server) await server.close();
    });

    it('starts a server and serves the host page', async () => {
      server = await sdk.createTestHostServer({
        productUrl: 'http://localhost:3001',
        accounts: ['alice', 'bob'],
      });

      assert.ok(server.url.startsWith('http://127.0.0.1:'));

      const res = await fetch(server.url);
      const html = await res.text();

      assert.ok(html.includes('id="product-frame"'), 'has iframe');
      assert.ok(html.includes('__TEST_HOST_CONFIG__'), 'has config');
      assert.ok(html.includes('http://localhost:3001'), 'has product URL');
      assert.ok(html.includes('Alice'), 'has Alice account');
      assert.ok(html.includes('Bob'), 'has Bob account');
      assert.ok(
        html.includes('<script type="module" src="/host-runtime.js">'),
        'loads the runtime as a module',
      );
      // Chrome 130+ blocks clipboard delegation to cross-origin iframes unless
      // the top-level page carries this header, so a refactor that drops it
      // must fail here rather than in a product's clipboard test.
      assert.match(
        res.headers.get('permissions-policy') ?? '',
        /clipboard-write/,
        'keeps the clipboard Permissions-Policy on the host page',
      );

      // The page is a shell now: the runtime, the core worker and the wasm the
      // core instantiates are separate assets, so a page that looks right is
      // not enough — every asset it pulls in has to be served, and served with
      // a content type the browser accepts.
      const runtime = await fetch(`${server.url}/host-runtime.js`);
      assert.strictEqual(runtime.status, 200, 'serves the host runtime chunk');
      assert.match(runtime.headers.get('content-type'), /javascript/, 'runtime is a JS module');
      const runtimeSource = await runtime.text();
      assert.ok(runtimeSource.includes('__TEST_HOST__'), 'runtime publishes the test-host API');
      assert.ok(runtimeSource.includes('worker-runtime.js'), 'runtime points at the worker chunk');

      const worker = await fetch(`${server.url}/worker-runtime.js`);
      assert.strictEqual(worker.status, 200, 'serves the core worker chunk');
      await worker.body.cancel();

      const wasm = await fetch(`${server.url}/truapi_server_bg.wasm`);
      assert.strictEqual(wasm.status, 200, 'serves the core wasm');
      assert.strictEqual(wasm.headers.get('content-type'), 'application/wasm', 'wasm mime type');
      await wasm.body.cancel();

      const missing = await fetch(`${server.url}/does-not-exist.js`);
      assert.strictEqual(missing.status, 404, 'a missing asset 404s');
      await missing.body.cancel();

      // Percent-encoded so the traversal survives URL normalisation and actually
      // reaches the server's own guard.
      const escaping = await fetch(`${server.url}/%2e%2e%2fpackage.json`);
      assert.strictEqual(escaping.status, 403, 'a traversing path is refused');
      await escaping.body.cancel();
    });
  });

  describe('productAccounts config', () => {
    let serverWithMap;

    after(async () => {
      if (serverWithMap) await serverWithMap.close();
    });

    it('passes productAccounts to host config when set', async () => {
      serverWithMap = await sdk.createTestHostServer({
        productUrl: 'http://localhost:3001',
        accounts: ['bob'],
        productAccounts: { 'myapp.dot/0': 'bob', 'myapp.dot/2': 'charlie' },
      });

      const res = await fetch(serverWithMap.url);
      const html = await res.text();

      const match = html.match(/window\.__TEST_HOST_CONFIG__\s*=\s*({.*?});/);
      assert.ok(match, 'config found in page');
      const config = JSON.parse(match[1]);
      assert.ok(config.productAccounts, 'productAccounts present');
      assert.strictEqual(config.productAccounts['myapp.dot/0'].uri, '//Bob');
      assert.strictEqual(config.productAccounts['myapp.dot/2'].uri, '//Charlie');
    });

    it('omits productAccounts from config when not set', async () => {
      const server = await sdk.createTestHostServer({
        productUrl: 'http://localhost:3001',
        accounts: ['alice'],
      });

      try {
        const res = await fetch(server.url);
        const html = await res.text();

        const match = html.match(/window\.__TEST_HOST_CONFIG__\s*=\s*({.*?});/);
        const config = JSON.parse(match[1]);
        assert.strictEqual(config.productAccounts, undefined, 'no productAccounts key');
      } finally {
        await server.close();
      }
    });
  });
});

describe('ESM import("@parity/host-api-test-sdk/playwright")', () => {
  /** @type {import('./dist/playwright/index')} */
  let pw;

  it('can be imported', async () => {
    pw = await import('./dist/playwright/index.js');
  });

  it('exports createTestHostFixture', () => {
    assert.strictEqual(typeof pw.createTestHostFixture, 'function');
  });

  it('exports chain configs', () => {
    assert.ok(pw.DEFAULT_CHAIN);
    assert.ok(pw.PASEO_ASSET_HUB);
    assert.ok(pw.PREVIEWNET);
    assert.ok(pw.PREVIEWNET_ASSET_HUB);
  });
});
