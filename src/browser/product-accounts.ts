/**
 * Which dev key signs for which product account.
 *
 * The core derives every indexed product account ITSELF. It asks the host once
 * for the product's hard subtree (`ProductSubtreeRequest`) and then applies the
 * account's 32-byte derivation index as ONE SOFT junction over that subtree
 * public key — `derive_product_public_key` in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/product_account.rs`,
 * reached from `runtime.rs::product_account_public_key`. Its symmetric secret
 * side is `derive_product_keypair_from_subtree_secret`, which is what the core
 * signs with when it holds the AutoSigning subtree secret.
 *
 * So the host has exactly one lever — WHICH keypair is a product's subtree —
 * and it must sign with the same soft derivation the core reports, or the
 * address a product is told it owns will not verify the product's own
 * signatures.
 *
 * Before the 0.17 core the host answered per index and this file hard-derived
 * `//Selected//dotnsId/index`. That path is gone: the core no longer asks for
 * an indexed account at all, so no host-side choice can bring those addresses
 * back, and `productAccounts` can only be keyed by the bare product id.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import type { DevKeypair } from './dev-accounts.js';
import { deriveFromUri, deriveSoft } from './dev-accounts.js';

/** Just enough of the host page config to resolve a product account. */
export interface ProductAccountConfig {
  /** Accounts in force; the first is the selected one. */
  accounts: ReadonlyArray<{ uri: string }>;
  /** `"dotnsId"` → the account whose key is that product's subtree root. */
  productAccounts?: Record<string, { uri: string }>;
}

/**
 * `blake2_256("product-account-index")[..28]` — the magic that separates plain
 * index space from raw 32-byte indexes (`index_magic`, core).
 */
const INDEX_MAGIC = blake2b(new TextEncoder().encode('product-account-index'), {
  dkLen: 32,
}).subarray(0, 28);

/** `index_bytes(n)`: the u32 little-endian, then the index magic. */
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
 * The 32-byte soft chain code for one wire `DerivationIndex`.
 *
 * Mirrors the core's `derivation_index_bytes`: `Index(n)` goes through
 * `index_bytes(n)`, while `Raw(bytes)` is passed through UNCHANGED — the two
 * spaces are disjoint by construction, which is what the magic buys.
 *
 * The parameter is `unknown` because that is what `ResolveAccount` passes —
 * an already-decoded `DerivationIndex` — so it is narrowed here rather than
 * assumed. An unrecognised shape throws, and the responder turns a handler
 * throw into a failure reply, so it surfaces to the product instead of
 * hanging it.
 */
export function derivationIndexBytes(derivationIndex: unknown): Uint8Array {
  if (typeof derivationIndex === 'object' && derivationIndex !== null && 'tag' in derivationIndex) {
    const { tag, value } = derivationIndex as { tag: unknown; value: unknown };
    if (tag === 'Index' && typeof value === 'number') return indexBytes(value);
    if (tag === 'Index' && typeof value === 'bigint') return indexBytes(Number(value));
    if (tag === 'Raw') {
      // The wire carries `Raw` as a 32-byte `HexString`; a `Uint8Array` is
      // accepted defensively. Anything not 32 bytes is not a chain code.
      const bytes = typeof value === 'string' ? hexToBytes(value) : value;
      if (bytes instanceof Uint8Array && bytes.length === 32) return bytes;
      throw new Error(`raw derivation index must be 32 bytes: ${describe(derivationIndex)}`);
    }
  }
  throw new Error(`unsupported derivation index: ${describe(derivationIndex)}`);
}

function hexToBytes(value: string): Uint8Array | undefined {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Readable rendering of an unexpected value for an error message. */
function describe(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'tag' in value) {
    return `{ tag: ${String((value as { tag: unknown }).tag)} }`;
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * The keypair that is one product's subtree root.
 *
 * A `productAccounts` entry wins; otherwise it is the hard junction
 * `//Selected//dotnsId` under the selected account, which is stable across
 * runs and distinct per product. This is the key `ProductSubtreeRequest`
 * reports, the key the AutoSigning grant hands over, and the parent every
 * account under the product soft-derives from.
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

/**
 * Resolve one product account to the keypair that signs for it.
 *
 * No `derivationIndex` means the request is a `ProductSubtreeRequest` and the
 * answer is the subtree root itself. Otherwise the account is the subtree soft-
 * derived at this index — byte-for-byte the derivation the core performs on the
 * subtree public key it was given, so the signer and the reported address are
 * the same key.
 */
export function resolveProductAccount(
  config: ProductAccountConfig,
  dotNsIdentifier: string,
  derivationIndex: unknown,
): DevKeypair {
  const subtree = resolveProductSubtree(config, dotNsIdentifier);
  if (derivationIndex === undefined || derivationIndex === null) return subtree;
  return deriveSoft(subtree, derivationIndexBytes(derivationIndex));
}
