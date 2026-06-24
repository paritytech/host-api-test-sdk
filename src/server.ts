import { createServer, type Server } from 'node:http';
import { generateHostPage } from './host-page.js';
import { DEFAULT_CHAIN } from './networks.js';
import type { CreateTestHostOptions, TestHostServer } from './types.js';

export async function createTestHostServer(
  options: CreateTestHostOptions,
): Promise<TestHostServer> {
  const {
    productUrl,
    accounts = ['alice'],
    networks = [DEFAULT_CHAIN],
    port = 0,
  } = options;

  const html = generateHostPage({
    productUrl,
    accounts,
    networks,
    productAccounts: options.productAccounts,
    faults: options.faults,
  });

  const server = createServer((req, res) => {
    // Serve the host page for any request
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      // Allow clipboard delegation to cross-origin iframes (Chrome 130+ enforcement).
      // The 'allow' attribute on <iframe> can only delegate permissions the parent
      // page itself has — without this header, clipboard-write is blocked for
      // cross-origin iframes regardless of the iframe's 'allow' attribute.
      'Permissions-Policy': 'clipboard-read=*, clipboard-write=*',
    });
    res.end(html);
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  return {
    url,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
