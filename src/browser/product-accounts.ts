/**
 * Which dev key signs for which product account.
 *
 * The SSO responder asks this for every signing request it answers, so the
 * path built here decides what address a product's funds sit at. It is kept
 * byte-identical to the pre-migration `//Selected//dotnsId/index` derivation
 * so configured addresses do not move across the migration.
 */
import type { DevKeypair } from './dev-accounts.js';
import { deriveFromUri } from './dev-accounts.js';

/** Just enough of the host page config to resolve a product account. */
export interface ProductAccountConfig {
  /** Accounts in force; the first is the selected one. */
  accounts: ReadonlyArray<{ uri: string }>;
  /** `"dotnsId/index"` (or a bare `"dotnsId"`) → the account to use instead. */
  productAccounts?: Record<string, { uri: string }>;
}

/**
 * Canonical string form of one account selector.
 *
 * `Index(n)` renders as the plain number, so `productAccounts` keys and the
 * derivation URIs this host builds stay byte-identical to the pre-migration
 * ones. `Raw(hex)` renders as its lowercased hex — the wire carries it as a
 * `HexString`, and a `Uint8Array` is accepted defensively. `undefined` has no
 * selector at all: it is a `ProductSubtreeRequest`, which names a product's
 * subtree root rather than an account under it.
 *
 * The parameter is `unknown` because that is what `ResolveAccount` passes —
 * an already-decoded `DerivationIndex` or nothing — so it is narrowed here
 * rather than assumed. An unrecognised shape throws, and the responder turns a
 * handler throw into a failure reply, so it surfaces to the product instead of
 * hanging it.
 */
export function selectorOf(derivationIndex: unknown): string | undefined {
  if (derivationIndex === undefined || derivationIndex === null) return undefined;
  if (typeof derivationIndex === 'object' && 'tag' in derivationIndex && 'value' in derivationIndex) {
    const { tag, value } = derivationIndex as { tag: unknown; value: unknown };
    if (tag === 'Index' && (typeof value === 'number' || typeof value === 'bigint')) {
      return String(value);
    }
    if (tag === 'Raw') {
      if (typeof value === 'string') return value.toLowerCase();
      if (value instanceof Uint8Array) {
        return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      }
    }
  }
  throw new Error(`unsupported derivation index: ${describe(derivationIndex)}`);
}

/** Readable rendering of an unexpected value for an error message. */
function describe(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'tag' in value) {
    return `{ tag: ${String((value as { tag: unknown }).tag)} }`;
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * The `productAccounts` key, and the junction, for one request.
 *
 * `myapp.dot` + `Index(0)` → `myapp.dot/0`; `myapp.dot` + no selector →
 * `myapp.dot`. Every indexed key contains a `/`, so a subtree root can never
 * collide with an account under it.
 */
export function accountKey(dotNsIdentifier: string, derivationIndex: unknown): string {
  const selector = selectorOf(derivationIndex);
  return selector === undefined ? dotNsIdentifier : `${dotNsIdentifier}/${selector}`;
}

/**
 * Resolve one product account to the keypair that signs for it.
 *
 * A `productAccounts` entry wins; otherwise derive under the selected
 * account. A request with no selector — a product's subtree root — derives at
 * `//Selected//dotnsId`, the parent label of every account under it, so it is
 * stable across runs and cannot collide with an indexed one.
 */
export function resolveProductAccount(
  config: ProductAccountConfig,
  dotNsIdentifier: string,
  derivationIndex: unknown,
): DevKeypair {
  const key = accountKey(dotNsIdentifier, derivationIndex);
  const override = config.productAccounts?.[key];
  if (override) return deriveFromUri(override.uri);
  const selected = config.accounts[0];
  if (!selected) throw new Error('no account is selected in this host');
  return deriveFromUri(`${selected.uri}//${key}`);
}
