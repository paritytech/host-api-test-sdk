/** Channel crypto for the SSO session, matching `session_aead_key` (`sso/pairing.rs`). */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const AEAD_NONCE_LEN = 12;

/**
 * HKDF-SHA256 over the X25519 shared secret, empty salt and info. A small-order
 * peer key gives a non-contributory exchange, which the core rejects as
 * `invalid X25519 public key` — so this throws rather than deriving from it.
 */
export function sessionAeadKey(
  encSecret: Uint8Array,
  peerEncPubkey: Uint8Array,
): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(encSecret, peerEncPubkey);
  } catch (cause) {
    throw new Error('invalid X25519 public key', { cause });
  }
  if (shared.every((byte) => byte === 0)) {
    throw new Error('invalid X25519 public key');
  }
  return hkdf(sha256, shared, undefined, undefined, 32);
}

/** Encrypt, returning `nonce || ciphertext`. */
export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(AEAD_NONCE_LEN)),
): Uint8Array {
  const ciphertext = chacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/** Decrypt a `nonce || ciphertext` blob. Throws if authentication fails. */
export function open(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length <= AEAD_NONCE_LEN) {
    throw new Error('sso payload too short');
  }
  const nonce = blob.subarray(0, AEAD_NONCE_LEN);
  const ciphertext = blob.subarray(AEAD_NONCE_LEN);
  return chacha20poly1305(key, nonce).decrypt(ciphertext);
}
