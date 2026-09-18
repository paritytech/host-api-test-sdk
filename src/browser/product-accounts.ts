/**
 * Which dev key signs for which product account.
 *
 * The core asks the host only for a product's subtree and derives every indexed
 * account itself, as ONE soft junction over that subtree public key. This host
 * must sign with the same derivation or a product's signature will not verify
 * against the address it was told it owns.
 *
 * Ground truth: `host_logic/product_account.rs`.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { type DerivationIndex, scale } from '@parity/truapi';
import type { DevKeypair } from './dev-accounts.js';
import { deriveFromUri, deriveSoft } from './dev-accounts.js';

export interface ProductAccountConfig {
  /** Accounts in force; the first is the selected one. */
  accounts: ReadonlyArray<{ uri: string }>;
  /** `"dotnsId"` → the account whose key is that product's subtree root. */
  productAccounts?: Record<string, { uri: string }>;
}

/** Core's `index_magic`: keeps plain index space disjoint from raw 32-byte indexes. */
const INDEX_MAGIC = blake2b(new TextEncoder().encode('product-account-index'), {
  dkLen: 32,
}).subarray(0, 28);

/** Core's `index_bytes(n)`. */
export function indexBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xff_ff_ff_ff) {
    throw new Error(`derivation index is not a u32: ${index}`);
  }
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index, true);
  bytes.set(INDEX_MAGIC, 4);
  return bytes;
}

/**
 * Core's `derivation_index_bytes`. `Raw` passes through unchanged; the magic is
 * what keeps it from colliding with `Index`.
 */
export function derivationIndexBytes(derivationIndex: DerivationIndex): Uint8Array {
  return derivationIndex.tag === 'Index'
    ? indexBytes(derivationIndex.value)
    : scale.hexToBytes(derivationIndex.value);
}

/**
 * The keypair reported for `ProductSubtreeRequest` and handed over by an
 * AutoSigning grant — the parent every account under the product derives from.
 */
export function resolveProductSubtree(
  config: ProductAccountConfig,
  dotNsIdentifier: string,
): DevKeypair {
  const override = config.productAccounts?.[dotNsIdentifier];
  if (override) return deriveFromUri(override.uri);
  const selected = config.accounts[0];
  if (!selected) throw new Error('no account is selected in this host');
  return deriveFromUri(`${selected.uri}//${dotNsIdentifier}`);
}

/** Resolve one product account to the keypair that signs for it. */
export function resolveProductAccount(
  config: ProductAccountConfig,
  dotNsIdentifier: string,
  derivationIndex: DerivationIndex | undefined,
): DevKeypair {
  const subtree = resolveProductSubtree(config, dotNsIdentifier);
  if (derivationIndex === undefined) return subtree;
  return deriveSoft(subtree, derivationIndexBytes(derivationIndex));
}
