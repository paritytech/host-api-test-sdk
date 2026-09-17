/**
 * Extrinsic construction and raw signing.
 *
 * Ported from the pre-migration `host-runtime.ts`; the layout is unchanged, only
 * the key source moved from @polkadot/keyring to @scure/sr25519.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { sign } from '@scure/sr25519';
import type { DevKeypair } from '../dev-accounts.js';

/** SCALE compact encoding for a length. */
function compactLength(value: number): Uint8Array {
  // Single byte: 0-63 encoded as (value << 2 | 00)
  if (value < 64) return new Uint8Array([value << 2]);
  // Two bytes: 64-16383 encoded as (value << 2 | 01) little-endian
  if (value < 2 ** 14) {
    const encoded = (value << 2) | 0b01;
    return new Uint8Array([encoded & 0xff, (encoded >> 8) & 0xff]);
  }
  // Four bytes: 16384+ encoded as (value << 2 | 10) little-endian
  if (value < 2 ** 30) {
    const encoded = (value << 2) | 0b10;
    return new Uint8Array([
      encoded & 0xff,
      (encoded >> 8) & 0xff,
      (encoded >> 16) & 0xff,
      (encoded >> 24) & 0xff,
    ]);
  }
  throw new Error(`length too large for compact encoding: ${value}`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Build a v4 signed extrinsic:
 *   [compact len][0x84][0x00][AccountId32][0x01][signature 64B][extras][callData]
 *
 * The signing payload is `callData || extras || additionalSigned`, hashed with
 * blake2-256 when it exceeds 256 bytes, per Substrate convention.
 */
export function buildSignedV4Extrinsic(
  keypair: DevKeypair,
  callData: Uint8Array,
  extensions: ReadonlyArray<{ extra: Uint8Array; additionalSigned: Uint8Array }>,
): Uint8Array {
  const extras = concat(extensions.map((extension) => extension.extra));
  const additional = concat(extensions.map((extension) => extension.additionalSigned));

  const payload = concat([callData, extras, additional]);
  const toSign = payload.length > 256 ? blake2b(payload, { dkLen: 32 }) : payload;
  const signature = sign(keypair.secretKey, toSign);

  const inner = concat([
    new Uint8Array([0x84, 0x00]),
    keypair.publicKey,
    new Uint8Array([0x01]),
    signature,
    extras,
    callData,
  ]);

  return concat([compactLength(inner.length), inner]);
}

/** Sign raw bytes, or the UTF-8 bytes of a text payload. */
export function signRawBytes(
  keypair: DevKeypair,
  payload: { tag: 'Bytes'; value: Uint8Array } | { tag: 'Payload'; value: string },
): Uint8Array {
  const data =
    payload.tag === 'Bytes' ? payload.value : new TextEncoder().encode(payload.value);
  return sign(keypair.secretKey, data);
}
