import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHostPage } from './host-page.js';
import { DEFAULT_CHAIN } from './networks.js';
import type { CreateTestHostOptions, TestHostServer } from './types.js';

/**
 * Where `build.mjs` puts the browser assets: the host runtime chunk, the worker
 * chunk, the shared chunks and the `.wasm` payloads.
 *
 * `import.meta.url` is this module's own file — `dist/server.js` for the ESM
 * build, and `dist/index.cjs` / `dist/playwright.cjs` for the CJS bundles, where
 * `build.mjs` defines it as `pathToFileURL(__filename)`. All three sit directly
 * in `dist/`, so `./host` beside them is the same directory in every case.
 */
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), 'host');

/**
 * `.js` matters: a module script served as anything but a JavaScript MIME type
 * is refused outright by the browser, which would break the whole page. `.wasm`
 * matters for `WebAssembly.instantiateStreaming`.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

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
  });

  const server = createServer((req, res) => {
    const path = requestPath(req);

    if (path === '/') {
      sendHostPage(res, html);
      return;
    }

    void sendAsset(res, path);
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

/** The pathname of a request, query string and percent-escapes removed. */
function requestPath(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    // An undecodable path can only be a bad request; it never names an asset.
    return '/';
  }
}

function sendHostPage(res: ServerResponse, html: string): void {
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
}

async function sendAsset(res: ServerResponse, path: string): Promise<void> {
  const file = resolveAsset(path);
  if (!file) {
    sendStatus(res, 403, 'Forbidden');
    return;
  }

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    // Missing, unreadable, or a directory — all 404 rather than hanging the load.
    sendStatus(res, 404, 'Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.byteLength,
  });
  res.end(body);
}

/** Map a request path into `ASSET_DIR`, or `null` if it would escape it. */
function resolveAsset(path: string): string | null {
  const file = normalize(join(ASSET_DIR, path));
  return file.startsWith(ASSET_DIR + sep) ? file : null;
}

function sendStatus(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
  });
  res.end(message);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
