/**
 * RFC-0022 ring-VRF key derivation and proof-context hashing.
 *
 * Vendored from the canonical implementations so this package stays free of
 * app-domain dependencies. The keyed-hash chain mirrors truapi
 * `host_logic/product_account.rs` and browse-sdk `personhood-keys.ts`, and
 * the proof context mirrors truapi `runtime/signing_host/ring_vrf.rs`
 * `context_bytes`. All of them must agree byte for byte. A key derived even
 * slightly differently is not rejected anywhere, it simply belongs to nobody.
 *
 * ```
 * root  = blake2b256(entropy, key: "ring-vrf")
 * child = blake2b256(parent, key: chain_code)
 * path  = //{domain}//index_bytes(n)
 * ```
 *
 * The personhood domain is `peopl.{tld}`, so the member key moves with the
 * TLD. The same mnemonic is a different person under `peopl.dot` than under
 * `peopl.test`. Callers pass the TLD of the network whose ring they prove
 * against.
 */

import { blake2b } from '@noble/hashes/blake2b';
import type { ProofSuffix } from './types.js';

const utf8 = (value: string) => new TextEncoder().encode(value);

const blake2b256 = (data: Uint8Array) => blake2b(data, { dkLen: 32 });

/** `hash(data, key)`, BLAKE2b-256 in keyed mode. */
const keyedHash = (data: Uint8Array, key: Uint8Array) =>
  blake2b(data, { key, dkLen: 32 });

const CHAIN_CODE_BYTES = 32;

/** Root key of the ring-VRF tree. */
const RING_VRF_ROOT_KEY = utf8('ring-vrf');

/** Governance-reserved label for the personhood ring-VRF domain. */
const PERSONHOOD_LABEL = 'peopl';

/** `blake2b256("product-account-index")[..28]`, the index-space separator. */
const INDEX_MAGIC = blake2b256(utf8('product-account-index')).subarray(0, 28);

/** SCALE compact length prefix, single, two, and four byte modes. */
function compactLength(length: number): Uint8Array {
  if (length < 1 << 6) return Uint8Array.of(length << 2);
  if (length < 1 << 14) {
    const value = (length << 2) | 0b01;
    return Uint8Array.of(value & 0xff, value >>> 8);
  }
  const value = (length << 2) | 0b10;
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    value >>> 24,
  );
}

/** SCALE `Vec<[u8; 32]>`: compact count followed by the concatenated keys. */
export function encodeMemberKeys(keys: Uint8Array[]): Uint8Array {
  const prefix = compactLength(keys.length);
  const out = new Uint8Array(prefix.length + keys.length * 32);
  out.set(prefix, 0);
  keys.forEach((key, i) => out.set(key, prefix.length + i * 32));
  return out;
}

/** `index_bytes(n)`: the index little-endian, then {@link INDEX_MAGIC}. */
function indexBytes(index: number): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, index, true);
  out.set(INDEX_MAGIC, 4);
  return out;
}

/** A path segment as a 32-byte junction chain code: padded SCALE, hashed when longer. */
function junctionChainCode(segment: string): Uint8Array {
  const bytes = utf8(segment);
  const encoded = new Uint8Array([...compactLength(bytes.length), ...bytes]);
  const out = new Uint8Array(CHAIN_CODE_BYTES);
  out.set(encoded.length > CHAIN_CODE_BYTES ? blake2b256(encoded) : encoded);
  return out;
}

/** Ring-VRF entropy at `//{domain}//index_bytes(index)`. Hard junctions only. */
function deriveRingVrfEntropy(
  entropy: Uint8Array,
  domain: string,
  index = 0,
): Uint8Array {
  return [junctionChainCode(domain), indexBytes(index)].reduce(
    (parent, chainCode) => keyedHash(parent, chainCode),
    keyedHash(entropy, RING_VRF_ROOT_KEY),
  );
}

/**
 * Entropy behind the bandersnatch member key the People chain knows a full
 * person by, at `//peopl.{tld}//index_bytes(0)`.
 */
export function fullPersonRingVrfEntropy(
  entropy: Uint8Array,
  tld: string,
): Uint8Array {
  return deriveRingVrfEntropy(entropy, `${PERSONHOOD_LABEL}.${tld}`, 0);
}

/**
 * The 32-byte proof context a real host binds a product proof to.
 *
 * `blake2b256("product/" ++ productId ++ "/" ++ suffixBytes)`, where the
 * suffix bytes are `index_bytes(n)` for a plain index and the raw 32 bytes
 * for a raw selector. Mirrors truapi `context_bytes`.
 */
export function productProofContext(
  productId: string,
  suffix: ProofSuffix,
): Uint8Array {
  const suffixBytes =
    suffix.tag === 'Index' ? indexBytes(suffix.value) : suffix.value;
  const head = utf8(`product/${productId}/`);
  const input = new Uint8Array(head.length + suffixBytes.length);
  input.set(head, 0);
  input.set(suffixBytes, head.length);
  return blake2b256(input);
}
