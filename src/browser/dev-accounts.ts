/**
 * Dev-account keys, derived in-page with no WASM crypto.
 *
 * Addresses are the canonical Substrate dev ones, so tests and funded testnet
 * accounts keep working across the migration.
 */
import { HDKD, getPublicKey, secretFromSeed } from '@scure/sr25519';
import { DEV_MINI_SECRET, ss58Address } from '@polkadot-labs/hdkd-helpers';

export interface DevKeypair {
  /**
   * 64-byte sr25519 secret in `@scure/sr25519`'s representation: the scalar
   * shifted ed25519-style (multiplied by the cofactor), then the nonce. This
   * is what every `@scure/sr25519` call here takes — and it is NOT the form
   * the core reads a raw secret in; see `canonicalSecretKey`.
   */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

/**
 * The same secret in schnorrkel's canonical `SecretKey::to_bytes()` form.
 *
 * schnorrkel has two 64-byte secret encodings: `to_bytes`/`from_bytes` carry
 * the scalar reduced mod l, while `to_ed25519_bytes`/`from_ed25519_bytes`
 * carry it multiplied by the cofactor. `@scure/sr25519` uses the latter;
 * `SecretKey::from_bytes` rejects it, because the shifted scalar is ~8x l and
 * fails the canonicity check.
 *
 * That matters wherever this host hands the core a raw secret. The core is not
 * uniform about it: `Sr25519Signer::from_secret_bytes`
 * (`host_logic/extrinsic.rs`) tries `from_bytes` and falls back to
 * `from_ed25519_bytes`, but `validate_auto_signing_key`
 * (`runtime/pairing_host.rs`) and `derive_product_keypair_from_subtree_secret`
 * (`host_logic/product_account.rs`) accept ONLY the canonical form — an
 * ed25519-shifted secret comes back as "AutoSigning capability contains an
 * invalid subtree secret". The canonical form is accepted everywhere, and
 * both forms name the same scalar, so the keys and signatures are identical.
 *
 * This is the inverse of schnorrkel's `divide_scalar_bytes_by_cofactor`: a
 * little-endian shift right by 3, leaving the nonce untouched.
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

function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value !== 'string') return value;
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const ROOT_SECRET = secretFromSeed(toBytes(DEV_MINI_SECRET as unknown as string));

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
 * Witness bytes for a soft derivation's child nonce.
 *
 * `HDKD.secretSoft` takes this as its `random` argument and folds it into the
 * child's NONCE only — the child's scalar, and therefore its public key and
 * address, come from the transcript alone. schnorrkel's own `derived_key`
 * randomises that nonce; this host pins it to zero so a derived account is
 * reproducible across runs. Nothing is weakened by it: the nonce is one of
 * three witness inputs (the parent nonce and the parent secret are the other
 * two), and `@scure/sr25519`'s `sign` draws fresh randomness per signature
 * regardless.
 */
const SOFT_DERIVATION_WITNESS = new Uint8Array(32);

/**
 * Soft-derive a child keypair at a 32-byte chain code.
 *
 * The counterpart of schnorrkel's `derived_key_simple(ChainCode(cc), [])`,
 * which is what the core calls for a product account
 * (`host_logic/product_account.rs`). Soft means the child public key is also
 * derivable from the parent PUBLIC key alone — which is exactly why the core
 * can derive product accounts itself from a subtree public key, and why this
 * host must use the same junction when it signs for one.
 */
export function deriveSoft(parent: DevKeypair, chainCode: Uint8Array): DevKeypair {
  if (chainCode.length !== 32) {
    throw new Error(`soft derivation chain code must be 32 bytes, got ${chainCode.length}`);
  }
  return fromSecret(HDKD.secretSoft(parent.secretKey, chainCode, SOFT_DERIVATION_WITNESS));
}

/**
 * Derive from a Substrate URI. Only hard junctions (`//x`) are supported —
 * every path this host builds uses them, and a soft junction would silently
 * produce a different address.
 */
export function deriveFromUri(uri: string): DevKeypair {
  if (uri.includes('/') && !uri.startsWith('//')) {
    throw new Error(`unsupported derivation URI: ${uri}`);
  }
  const junctions = uri.split('//').filter((part) => part.length > 0);
  return deriveDev(...junctions);
}
