/**
 * Extrinsic construction and raw signing.
 *
 * Ported from the pre-migration `host-runtime.ts`; the layout is unchanged, only
 * the key source moved from @polkadot/keyring to @scure/sr25519.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
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

/** A `RawPayload`: opaque bytes, or a string the `isHex` rule interprets. */
export type RawSignPayload =
  | { tag: 'Bytes'; value: Uint8Array }
  | { tag: 'Payload'; value: string };

const BYTES_WRAP_PREFIX = new TextEncoder().encode('<Bytes>');
const BYTES_WRAP_SUFFIX = new TextEncoder().encode('</Bytes>');

const startsWith = (data: Uint8Array, prefix: Uint8Array) =>
  data.length >= prefix.length && prefix.every((byte, i) => data[i] === byte);
const endsWith = (data: Uint8Array, suffix: Uint8Array) =>
  data.length >= suffix.length &&
  suffix.every((byte, i) => data[data.length - suffix.length + i] === byte);

/**
 * Interpret a string payload the way polkadot-app does.
 *
 * `isHex` means a `0x` prefix *and* an even total length. A string that looks
 * like hex but is not valid hex is a hard error rather than silently signed as
 * UTF-8; anything else is signed as its UTF-8 bytes. Mirrors
 * `decode_payload_string` in
 * `../host-rust-core/rust/crates/truapi-server/src/runtime/signing_host.rs`.
 */
function decodePayloadString(payload: string): Uint8Array {
  if (!payload.startsWith('0x') || payload.length % 2 !== 0) {
    return new TextEncoder().encode(payload);
  }
  try {
    return hexToBytes(payload.slice(2));
  } catch (cause) {
    throw new Error('raw sign payload is 0x-prefixed but not valid hex', { cause });
  }
}

/**
 * The bytes a raw-signing request actually signs.
 *
 * A watermarked request is wrapped in `<Bytes>…</Bytes>` — the polkadot-app
 * convention that keeps a raw signature from being mistaken for an extrinsic —
 * unless the payload already carries the wrapper. The deprecated
 * `…Unwatermarked` request variants skip it. Mirrors `raw_payload_bytes`.
 */
export function rawPayloadBytes(payload: RawSignPayload, watermarked: boolean): Uint8Array {
  const raw = payload.tag === 'Bytes' ? payload.value : decodePayloadString(payload.value);
  if (!watermarked || (startsWith(raw, BYTES_WRAP_PREFIX) && endsWith(raw, BYTES_WRAP_SUFFIX))) {
    return raw;
  }
  return concat([BYTES_WRAP_PREFIX, raw, BYTES_WRAP_SUFFIX]);
}

/** Sign a raw payload, optionally under the `<Bytes>` watermark. */
export function signRawBytes(
  keypair: DevKeypair,
  payload: RawSignPayload,
  watermarked = false,
): Uint8Array {
  return sign(keypair.secretKey, rawPayloadBytes(payload, watermarked));
}
