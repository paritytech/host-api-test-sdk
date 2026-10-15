/**
 * Runtime metadata for the in-page signing host, read over the same chain
 * routing the core uses. A phone reads it from its own chain client; this host
 * reads it only for a transaction on a non-zero `txExtVersion`, so a product
 * that never asks for one keeps its tests off the network.
 */
import { type HexString, scale } from '@parity/truapi';
import type { ChainProvider, JsonRpcConnection } from '@parity/truapi-host';
import { normalizeGenesisHash } from './callbacks/chain.js';
import type { TransactionMetadata } from './signing/general.js';

export type ReadMetadata = (genesisHash: HexString) => Promise<TransactionMetadata>;

/** Long enough for a 700 kB answer over a slow link; short enough for a test to report it. */
export const METADATA_TIMEOUT_MS = 20_000;

/** `16u32`, little-endian: the newest metadata version, the only one with pipelines above 0. */
const METADATA_V16 = '0x10000000';

/**
 * One metadata read per genesis for the page's life; a failed read is
 * forgotten so the next transaction tries again. A runtime upgrade during a
 * test is not picked up.
 */
export function createMetadataReader(chain: ChainProvider): ReadMetadata {
  const cache = new Map<string, Promise<TransactionMetadata>>();
  return (genesisHash) => {
    const key = normalizeGenesisHash(genesisHash);
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchMetadata(chain, key);
      cache.set(key, pending);
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  };
}

async function fetchMetadata(
  chain: ChainProvider,
  genesisHash: HexString,
): Promise<TransactionMetadata> {
  let connection: JsonRpcConnection | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    connection?.close();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error(`no answer within ${METADATA_TIMEOUT_MS / 1000} s`));
    }, METADATA_TIMEOUT_MS);
  });

  try {
    const read = chain.connect(scale.hexToBytes(genesisHash)).then((opened) => {
      connection = opened;
      if (closed) {
        // Opened after the timeout fired: close it and read nothing.
        opened.close();
        throw new Error('the connection opened after the timeout');
      }
      return readMetadataBytes(opened);
    });
    const [bytes, { readTransactionMetadata }] = await Promise.all([
      Promise.race([read, timeout]),
      import('./signing/general.js'),
    ]);
    return readTransactionMetadata(bytes);
  } catch (cause) {
    // The core's `LocalTransactionError::ChainUnavailable` wording.
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`cannot load chain metadata: ${reason}`, { cause });
  } finally {
    clearTimeout(timer);
    close();
  }
}

/**
 * V16 where the runtime has it. Otherwise `state_getMetadata`'s V14, which
 * declares pipeline 0 only, so the version is refused the way the core refuses
 * it: when the runtime answers `None`, and when it refuses the call.
 */
async function readMetadataBytes(connection: JsonRpcConnection): Promise<Uint8Array> {
  const responses = connection.responses()[Symbol.asyncIterator]();
  let nextId = 0;
  const request = async (method: string, params: unknown[]): Promise<unknown> => {
    const id = ++nextId;
    connection.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (;;) {
      const frame = await responses.next();
      if (frame.done) throw new Error(`the connection closed before ${method} answered`);
      const message = JSON.parse(frame.value) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== id) continue;
      if (message.error !== undefined) {
        throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
      }
      return message.result;
    }
  };

  const { metadataFromRuntimeCall } = await import('./signing/general.js');
  let refused: Error | undefined;
  try {
    const answer = await request('state_call', ['Metadata_metadata_at_version', METADATA_V16]);
    const v16 = metadataFromRuntimeCall(scale.hexToBytes(answer as HexString));
    if (v16) return v16;
  } catch (cause) {
    // A closed connection will not answer the fallback either.
    if (!(cause instanceof Error) || cause.message.startsWith('the connection closed')) throw cause;
    refused = cause;
  }
  try {
    return scale.hexToBytes((await request('state_getMetadata', [])) as HexString);
  } catch (cause) {
    if (!refused || !(cause instanceof Error)) throw cause;
    throw new Error(`${refused.message}; ${cause.message}`, { cause });
  }
}
