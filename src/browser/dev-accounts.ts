/**
 * Dev-account keys, derived in-page with no WASM crypto.
 *
 * Addresses are the canonical Substrate dev ones, so tests and funded testnet
 * accounts keep working across the migration.
 */
import { HDKD, getPublicKey, secretFromSeed } from '@scure/sr25519';
import { DEV_MINI_SECRET, ss58Address } from '@polkadot-labs/hdkd-helpers';

export type DevAccountName = 'alice' | 'bob' | 'charlie' | 'dave' | 'eve' | 'ferdie';

export const DEV_ACCOUNT_URIS: Record<DevAccountName, string> = {
  alice: '//Alice',
  bob: '//Bob',
  charlie: '//Charlie',
  dave: '//Dave',
  eve: '//Eve',
  ferdie: '//Ferdie',
};

export interface DevKeypair {
  /** 64-byte expanded sr25519 secret — what `SecretKey::from_bytes` expects. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
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
  let secretKey = ROOT_SECRET;
  for (const junction of junctions) {
    secretKey = HDKD.secretHard(secretKey, chainCode(junction));
  }
  return fromSecret(secretKey);
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
