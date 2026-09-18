/**
 * Dev-account keys, derived in-page with no WASM crypto. Addresses are the
 * canonical Substrate dev ones, so funded testnet accounts keep working.
 */
import { HDKD, getPublicKey, secretFromSeed } from '@scure/sr25519';
import { DEV_MINI_SECRET, ss58Address } from '@polkadot-labs/hdkd-helpers';
import { scale } from '@parity/truapi';

export interface DevKeypair {
  /**
   * `@scure/sr25519`'s representation: the scalar multiplied by the cofactor,
   * then the nonce. NOT the form the core reads a raw secret in — see
   * `canonicalSecretKey`.
   */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

/**
 * The same secret in schnorrkel's canonical `SecretKey::to_bytes()` form —
 * needed wherever this host hands the core a raw secret.
 *
 * `@scure/sr25519` emits the cofactor-multiplied scalar, which
 * `SecretKey::from_bytes` rejects as non-canonical; `validate_auto_signing_key`
 * (`runtime/pairing_host.rs`) and `derive_product_keypair_from_subtree_secret`
 * take only the canonical one, and a shifted secret surfaces as "AutoSigning
 * capability contains an invalid subtree secret". Both forms name the same
 * scalar, so keys and signatures are unchanged.
 *
 * Inverse of schnorrkel's `divide_scalar_bytes_by_cofactor`.
 */
export function canonicalSecretKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) {
    throw new Error(`sr25519 secret must be 64 bytes, got ${secretKey.length}`);
  }
  const out = new Uint8Array(secretKey);
  let low = 0;
  for (let i = 31; i >= 0; i--) {
    const remainder = out[i] & 0b0000_0111;
    out[i] = (out[i] >>> 3) + low;
    low = (remainder << 5) & 0xff;
  }
  return out;
}

const ROOT_SECRET = secretFromSeed(scale.hexToBytes(DEV_MINI_SECRET));

/** SCALE chain code for a junction label: compact length prefix, then the bytes. */
function chainCode(label: string): Uint8Array {
  const encoded = new TextEncoder().encode(label);
  if (encoded.length >= 32) {
    throw new Error(`derivation junction too long: ${label}`);
  }
  const cc = new Uint8Array(32);
  cc[0] = encoded.length << 2;
  cc.set(encoded, 1);
  return cc;
}

function fromSecret(secretKey: Uint8Array): DevKeypair {
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, address: ss58Address(publicKey, 42) };
}

/** Derive a dev account by hard junctions: `deriveDev('Alice', 'myapp.dot/0')`. */
export function deriveDev(...junctions: string[]): DevKeypair {
  let secretKey: Uint8Array = ROOT_SECRET;
  for (const junction of junctions) {
    secretKey = HDKD.secretHard(secretKey, chainCode(junction));
  }
  return fromSecret(secretKey);
}

/**
 * Folded into the child's NONCE only — the scalar, public key and address come
 * from the transcript alone. schnorrkel randomises this; pinned to zero here so
 * a derived account is reproducible across runs, which costs nothing because
 * `sign` draws fresh randomness per signature anyway.
 */
const SOFT_DERIVATION_WITNESS = new Uint8Array(32);

/**
 * Counterpart of schnorrkel's `derived_key_simple(ChainCode(cc), [])`, which is
 * what the core calls for a product account (`host_logic/product_account.rs`).
 * Being soft is why the core can derive from a subtree PUBLIC key alone — and
 * why this host must use the same junction when it signs.
 */
export function deriveSoft(parent: DevKeypair, chainCode: Uint8Array): DevKeypair {
  if (chainCode.length !== 32) {
    throw new Error(`soft derivation chain code must be 32 bytes, got ${chainCode.length}`);
  }
  return fromSecret(HDKD.secretSoft(parent.secretKey, chainCode, SOFT_DERIVATION_WITNESS));
}

/** Hard junctions (`//x`) only; a soft junction would silently give a different address. */
export function deriveFromUri(uri: string): DevKeypair {
  if (uri.includes('/') && !uri.startsWith('//')) {
    throw new Error(`unsupported derivation URI: ${uri}`);
  }
  const junctions = uri.split('//').filter((part) => part.length > 0);
  return deriveDev(...junctions);
}
