/**
 * Shared scaffolding for the Playwright specs: ephemeral static servers for
 * product pages and test-host page loading.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Serve a product page (one HTML shell + one script bundle) on an ephemeral port. */
export async function serveProduct(
  htmlFile: string,
  bundleFile: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const html = readFileSync(join(__dirname, htmlFile), 'utf-8');
  const bundle = readFileSync(join(__dirname, bundleFile), 'utf-8');

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
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

/** Load the test host page, wait for its control API, return the product frame locator. */
export async function loadHost(page: import('@playwright/test').Page, hostUrl: string) {
  await page.goto(hostUrl);
  await page.waitForFunction(() => !!window.__TEST_HOST__, { timeout: 15_000 });
  return page.frameLocator('#product-frame');
}
