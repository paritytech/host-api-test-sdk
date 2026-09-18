import { describe, expect, it } from 'vitest';
import { HDKD, getPublicKey, sign, verify } from '@scure/sr25519';
import { deriveFromUri, deriveSoft } from './dev-accounts.js';
import {
  derivationIndexBytes,
  indexBytes,
  resolveProductAccount,
  resolveProductSubtree,
} from './product-accounts.js';

/** The selected account every case below derives under. */
const ALICE = { accounts: [{ uri: '//Alice' }] };

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Pin the derivation PATH, not just the address: `dev-accounts.spec.ts` already pins addresses. */
const derivesAt = (keypair: { address: string }, uri: string) =>
  expect(keypair.address).toBe(deriveFromUri(uri).address);

/** The account the CORE would report for this subtree and index. */
const coreAccount = (subtreeUri: string, index: number) =>
  deriveSoft(deriveFromUri(subtreeUri), indexBytes(index));

describe('indexBytes', () => {
  /**
   * The core's `index_bytes` vector, pinned in
   * `host_logic/product_account.rs::index_bytes_matches_ios_vector` and
   * cross-checked there against polkadot-app-ios-v2.
   */
  it('matches the core (and iOS) vector for index 0', () => {
    expect(hex(indexBytes(0))).toBe(
      '0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f',
    );
  });

  it('puts the index little-endian in front of the magic', () => {
    expect(Array.from(indexBytes(5).subarray(0, 4))).toEqual([5, 0, 0, 0]);
    expect(hex(indexBytes(5).subarray(4))).toBe(hex(indexBytes(0).subarray(4)));
  });

  it('refuses anything that is not a u32', () => {
    expect(() => indexBytes(-1)).toThrow(/not a u32/);
    expect(() => indexBytes(2 ** 32)).toThrow(/not a u32/);
    expect(() => indexBytes(1.5)).toThrow(/not a u32/);
  });
});

describe('derivationIndexBytes', () => {
  it('routes Index through index_bytes', () => {
    expect(hex(derivationIndexBytes({ tag: 'Index', value: 7 }))).toBe(hex(indexBytes(7)));
  });

  it('passes a Raw index through unchanged, as the core does', () => {
    expect(hex(derivationIndexBytes({ tag: 'Raw', value: `0x${'ee'.repeat(32)}` }))).toBe(
      'ee'.repeat(32),
    );
  });

  it('keeps raw index space disjoint from plain index space', () => {
    // `index_bytes(0)`'s magic cannot collide with a raw index of all zeroes.
    expect(hex(derivationIndexBytes({ tag: 'Raw', value: `0x${'00'.repeat(32)}` }))).not.toBe(
      hex(indexBytes(0)),
    );
  });

  it('refuses a Raw index that is not a 32-byte chain code', () => {
    expect(() =>
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Raw', value: '0xaabb' }),
    ).toThrow(/chain code must be 32 bytes/);
  });
});

describe('resolveProductSubtree', () => {
  it("derives a subtree at the product's own hard junction", () => {
    derivesAt(resolveProductSubtree(ALICE, 'myapp.dot'), '//Alice//myapp.dot');
  });

  it('follows the selected account, so switching accounts moves the subtree', () => {
    derivesAt(resolveProductSubtree({ accounts: [{ uri: '//Bob' }] }, 'myapp.dot'), '//Bob//myapp.dot');
  });

  it('lets a productAccounts entry replace the subtree', () => {
    const config = { ...ALICE, productAccounts: { 'myapp.dot': { uri: '//Charlie' } } };
    derivesAt(resolveProductSubtree(config, 'myapp.dot'), '//Charlie');
    // Another product is untouched by the entry.
    derivesAt(resolveProductSubtree(config, 'other.dot'), '//Alice//other.dot');
  });

  it('refuses to derive with no selected account', () => {
    expect(() => resolveProductSubtree({ accounts: [] }, 'myapp.dot')).toThrow(
      /no account is selected/,
    );
  });
});

describe('resolveProductAccount', () => {
  /**
   * The property the whole file exists for: the key this host SIGNS with is the
   * one the core DERIVES from the subtree PUBLIC key alone, reproduced here
   * with the public-only half of the same junction.
   */
  it('signs with the key the core derives from the subtree public key', () => {
    const subtree = resolveProductSubtree(ALICE, 'myapp.dot');
    for (const index of [0, 1, 9]) {
      const signer = resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: index });
      const reported = HDKD.publicSoft(subtree.publicKey, indexBytes(index));
      expect(hex(signer.publicKey)).toBe(hex(reported));
      const message = new Uint8Array([1, 2, 3]);
      expect(verify(message, sign(signer.secretKey, message), reported)).toBe(true);
      expect(hex(getPublicKey(signer.secretKey))).toBe(hex(reported));
    }
  });

  it('derives the same account from a Raw index as the core would', () => {
    const subtree = resolveProductSubtree(ALICE, 'myapp.dot');
    const signer = resolveProductAccount(ALICE, 'myapp.dot', {
      tag: 'Raw',
      value: `0x${'ee'.repeat(32)}`,
    });
    expect(hex(signer.publicKey)).toBe(
      hex(HDKD.publicSoft(subtree.publicKey, new Uint8Array(32).fill(0xee))),
    );
  });

  // The cross-implementation pin against schnorrkel's own vector lives with the
  // primitive, in `dev-accounts.spec.ts` (`deriveSoft`).

  it('answers a subtree request with the subtree root itself', () => {
    derivesAt(resolveProductAccount(ALICE, 'myapp.dot', undefined), '//Alice//myapp.dot');
  });

  it('never confuses a subtree root with an account under it', () => {
    expect(resolveProductAccount(ALICE, 'myapp.dot', undefined).address).not.toBe(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 0 }).address,
    );
  });

  it('moves every indexed account when productAccounts replaces the subtree', () => {
    const config = { ...ALICE, productAccounts: { 'myapp.dot': { uri: '//Bob' } } };
    for (const index of [0, 3]) {
      expect(
        resolveProductAccount(config, 'myapp.dot', { tag: 'Index', value: index }).address,
      ).toBe(coreAccount('//Bob', index).address);
      // …and away from where the unmapped product derives.
      expect(
        resolveProductAccount(config, 'myapp.dot', { tag: 'Index', value: index }).address,
      ).not.toBe(coreAccount('//Alice//myapp.dot', index).address);
    }
  });

  it('leaves an unmapped product on the default subtree', () => {
    const config = { ...ALICE, productAccounts: { 'other.dot': { uri: '//Bob' } } };
    expect(resolveProductAccount(config, 'myapp.dot', { tag: 'Index', value: 0 }).address).toBe(
      coreAccount('//Alice//myapp.dot', 0).address,
    );
  });

  it('gives each index its own account', () => {
    const zero = resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 0 });
    const one = resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 1 });
    expect(zero.address).not.toBe(one.address);
  });

  it('is deterministic across calls, so an account does not move mid-run', () => {
    expect(resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 0 }).secretKey).toEqual(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 0 }).secretKey,
    );
  });
});
