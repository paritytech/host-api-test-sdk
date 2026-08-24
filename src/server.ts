import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { generateHostPage } from './host-page.js';
import { DEFAULT_CHAIN } from './networks.js';
import type {
  CreateTestHostOptions,
  ProofSuffix,
  RingVrfProofsOptions,
} from './types.js';
import type { TestHostServer } from './types.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** The wire shape the runtime posts to `/__create-proof`. */
interface CreateProofBody {
  uri: string;
  productId: string;
  suffix: { tag: 'Index'; value: number } | { tag: 'Raw'; value: string };
  message: string;
}

/**
 * Answer a proof request from the browser runtime with a real ring-VRF proof.
 *
 * The runtime resolves which account URI signs, since account precedence
 * lives in the browser. This route only proves.
 */
async function handleCreateProof(
  req: IncomingMessage,
  res: ServerResponse,
  ringOptions: RingVrfProofsOptions,
): Promise<void> {
  try {
    const { buildRingProof, bytesOfHex, hexOfBytes } =
      await import('./ring-proof.js');
    const body = JSON.parse(await readBody(req)) as CreateProofBody;
    const suffix: ProofSuffix =
      body.suffix.tag === 'Raw'
        ? { tag: 'Raw', value: bytesOfHex(body.suffix.value) }
        : body.suffix;
    const result = await buildRingProof(ringOptions, {
      uri: body.uri,
      productId: body.productId,
      suffix,
      message: bytesOfHex(body.message),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        proof: hexOfBytes(result.proof),
        context: hexOfBytes(result.context),
        alias: hexOfBytes(result.alias),
        ringIndex: result.ringIndex,
        ringRevision: result.ringRevision,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

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
    ringVrfProofs: Boolean(options.ringVrfProofs),
  });

  const server = createServer((req, res) => {
    // Real ring-VRF proofs are built server-side. The wasm prover and the
    // ring reads have no place in the browser bundle. The runtime's
    // handleAccountCreateProof posts here when `ringVrfProofs` is configured.
    const ringOptions = options.ringVrfProofs;
    if (ringOptions && req.method === 'POST' && req.url === '/__create-proof') {
      void handleCreateProof(req, res, ringOptions);
      return;
    }

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
