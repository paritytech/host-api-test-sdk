import { describe, expect, it } from 'vitest';
import { deriveFromUri } from './dev-accounts.js';
import { accountKey, resolveProductAccount, selectorOf } from './product-accounts.js';

/** The selected account every case below derives under. */
const ALICE = { accounts: [{ uri: '//Alice' }] };

/** Pin the derivation PATH, not just the address: `dev-accounts.spec.ts` already pins addresses. */
const derivesAt = (keypair: { address: string }, uri: string) =>
  expect(keypair.address).toBe(deriveFromUri(uri).address);

describe('selectorOf', () => {
  it('renders Index as the plain number, as the pre-migration host did', () => {
    expect(selectorOf({ tag: 'Index', value: 0 })).toBe('0');
    expect(selectorOf({ tag: 'Index', value: 7 })).toBe('7');
  });

  it('renders Raw as lowercased hex, whichever case the wire used', () => {
    expect(selectorOf({ tag: 'Raw', value: '0xAABB' })).toBe('0xaabb');
    expect(selectorOf({ tag: 'Raw', value: new Uint8Array([0xaa, 0x0b]) })).toBe('0xaa0b');
  });

  it('has no selector for a subtree request', () => {
    expect(selectorOf(undefined)).toBeUndefined();
  });

  it('throws on a shape it does not recognise, rather than inventing a path', () => {
    expect(() => selectorOf({ tag: 'Something', value: 1 })).toThrow(/unsupported derivation index/);
    expect(() => selectorOf('0')).toThrow(/unsupported derivation index/);
    expect(() => selectorOf({ tag: 'Index', value: 'zero' })).toThrow(/unsupported derivation index/);
  });
});

describe('accountKey', () => {
  it('separates an indexed account from its subtree root', () => {
    expect(accountKey('myapp.dot', { tag: 'Index', value: 0 })).toBe('myapp.dot/0');
    expect(accountKey('myapp.dot', undefined)).toBe('myapp.dot');
  });
});

describe('resolveProductAccount', () => {
  it('derives an indexed account at the pre-migration path', () => {
    derivesAt(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 0 }),
      '//Alice//myapp.dot/0',
    );
    derivesAt(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 2 }),
      '//Alice//myapp.dot/2',
    );
  });

  it('derives a Raw selector at its lowercased hex path', () => {
    derivesAt(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Raw', value: '0xAABB' }),
      '//Alice//myapp.dot/0xaabb',
    );
    // Case only affects the label, so both spellings reach the same key.
    expect(resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Raw', value: '0xAABB' }).address).toBe(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Raw', value: '0xaabb' }).address,
    );
  });

  it("derives a subtree root at the product's own junction, with no index", () => {
    derivesAt(resolveProductAccount(ALICE, 'myapp.dot', undefined), '//Alice//myapp.dot');
  });

  it('never confuses a subtree root with an account under it', () => {
    expect(resolveProductAccount(ALICE, 'myapp.dot', undefined).address).not.toBe(
      resolveProductAccount(ALICE, 'myapp.dot', { tag: 'Index', value: 0 }).address,
    );
  });

  it('follows the selected account, so switching accounts moves the derivation', () => {
    derivesAt(
      resolveProductAccount({ accounts: [{ uri: '//Bob' }] }, 'myapp.dot', { tag: 'Index', value: 0 }),
      '//Bob//myapp.dot/0',
    );
  });

  it('lets a productAccounts entry override an indexed account', () => {
    const config = {
      ...ALICE,
      productAccounts: { 'myapp.dot/0': { uri: '//Bob' } },
    };
    derivesAt(resolveProductAccount(config, 'myapp.dot', { tag: 'Index', value: 0 }), '//Bob');
    // A different index is untouched by the override.
    derivesAt(
      resolveProductAccount(config, 'myapp.dot', { tag: 'Index', value: 1 }),
      '//Alice//myapp.dot/1',
    );
  });

  it('lets a productAccounts entry override a subtree root, keyed by the bare id', () => {
    const config = { ...ALICE, productAccounts: { 'myapp.dot': { uri: '//Charlie' } } };
    derivesAt(resolveProductAccount(config, 'myapp.dot', undefined), '//Charlie');
    // The bare key must not capture the indexed accounts.
    derivesAt(
      resolveProductAccount(config, 'myapp.dot', { tag: 'Index', value: 0 }),
      '//Alice//myapp.dot/0',
    );
  });

  it('refuses to derive with no selected account', () => {
    expect(() => resolveProductAccount({ accounts: [] }, 'myapp.dot', undefined)).toThrow(
      /no account is selected/,
    );
  });
});
