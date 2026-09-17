import { describe, expect, it } from 'vitest';
import { HDKD, getPublicKey, secretFromSeed } from '@scure/sr25519';
import { entropyToMiniSecret, ss58Address } from '@polkadot-labs/hdkd-helpers';
import { canonicalSecretKey, deriveDev, deriveFromUri, deriveSoft } from './dev-accounts.js';

describe('dev account derivation', () => {
  it('reproduces the canonical dev addresses', () => {
    expect(deriveDev('Alice').address).toBe(
      '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    );
    expect(deriveDev('Bob').address).toBe(
      '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
    );
  });

  it('exposes the 64-byte expanded secret the core requires', () => {
    const alice = deriveDev('Alice');
    expect(alice.secretKey).toHaveLength(64);
    expect(alice.publicKey).toHaveLength(32);
  });

  it('parses substrate URIs, including nested junctions', () => {
    expect(deriveFromUri('//Alice').address).toBe(deriveDev('Alice').address);
    expect(deriveFromUri('//Alice//myapp.dot/0').address).toBe(
      deriveDev('Alice', 'myapp.dot/0').address,
    );
  });

  it('derives distinct keys per junction', () => {
    expect(deriveDev('Alice', 'a').address).not.toBe(deriveDev('Alice', 'b').address);
  });

  describe('canonicalSecretKey', () => {
    /** The sr25519 group order, `l`. */
    const ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
    /** The 32-byte little-endian scalar half, as an integer. */
    const scalarOf = (secret: Uint8Array) =>
      secret
        .slice(0, 32)
        .reduceRight((accumulator, byte) => (accumulator << 8n) + BigInt(byte), 0n);

    it('reduces the ed25519-shifted scalar below the group order', () => {
      const alice = deriveDev('Alice');
      // `@scure/sr25519` hands out the cofactor-multiplied scalar, which
      // `SecretKey::from_bytes` refuses.
      expect(scalarOf(alice.secretKey) < ORDER).toBe(false);
      expect(scalarOf(canonicalSecretKey(alice.secretKey)) < ORDER).toBe(true);
    });

    it('divides the scalar by the cofactor and leaves the nonce alone', () => {
      const alice = deriveDev('Alice');
      const canonical = canonicalSecretKey(alice.secretKey);
      expect(scalarOf(canonical)).toBe(scalarOf(alice.secretKey) / 8n);
      expect(canonical.slice(32)).toEqual(alice.secretKey.slice(32));
      // A copy, never a mutation of the caller's key.
      expect(alice.secretKey).toEqual(deriveDev('Alice').secretKey);
    });

    it('refuses a secret that is not 64 bytes', () => {
      expect(() => canonicalSecretKey(new Uint8Array(32))).toThrow(/64 bytes/);
    });
  });

  describe('deriveSoft', () => {
    const hex = (bytes: Uint8Array) =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

    /** SCALE chain code for a hard string junction, as `deriveDev` builds it. */
    const junction = (label: string) => {
      const encoded = new TextEncoder().encode(label);
      const cc = new Uint8Array(32);
      cc[0] = encoded.length << 2;
      cc.set(encoded, 1);
      return cc;
    };

    /**
     * Cross-implementation check against schnorrkel, NOT a self-computed pin.
     *
     * The three expected values below are the ones the core's own Rust tests
     * assert in `truapi-server/src/host_logic/product_account.rs`
     * (`root_keypair_from_entropy_regression_pin` and
     * `wire_index_derivation_matches_the_mobile_vector`), where schnorrkel
     * computed them. Reproducing the last one here proves `HDKD.secretSoft`
     * is the counterpart of `derived_key_simple(ChainCode(cc), [])` — the
     * junction `derive_product_public_key` applies — down to the byte.
     */
    it("reproduces schnorrkel's product-account vector", () => {
      const root = secretFromSeed(entropyToMiniSecret(new Uint8Array(16).fill(0xab)));
      expect(hex(getPublicKey(root))).toBe(
        '0062ba8ae929ea64bc2ad6f21359e96a29e236a41d376d1c5ba76491da94fc72',
      );

      // `//product//myapp.dot`, the hard subtree the core firewalls a product
      // behind and the only thing it asks a host for.
      const subtreeSecret = HDKD.secretHard(
        HDKD.secretHard(root, junction('product')),
        junction('myapp.dot'),
      );
      const publicKey = getPublicKey(subtreeSecret);
      const subtree = {
        secretKey: subtreeSecret,
        publicKey,
        address: ss58Address(publicKey, 42),
      };

      // `derivation_index_bytes(DerivationIndex::Index(0))`, spelled out from
      // the core's own `index_bytes_matches_ios_vector` rather than recomputed,
      // so this test does not lean on `product-accounts.ts`.
      const indexZero = Uint8Array.from(
        '0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f'.match(/../g)!,
        (byte) => Number.parseInt(byte, 16),
      );
      const account = deriveSoft(subtree, indexZero);

      expect(hex(account.publicKey)).toBe(
        '1c1ae478b564572f806ffa6352b4273d612beb01610b19f4e5bf444521cd5b5c',
      );
      expect(account.address).toBe('5ChZBnBw9eDQUMBhnXUKrGMdK5MTfGrca3T1xZZtBQhW8eis');
      // The secret and public halves of the junction agree, which is what lets
      // the core derive an address this host can then sign for.
      expect(hex(HDKD.publicSoft(subtree.publicKey, indexZero))).toBe(hex(account.publicKey));
    });

    it('is deterministic: the same parent and chain code give the same secret', () => {
      const alice = deriveDev('Alice');
      const cc = new Uint8Array(32).fill(7);
      expect(deriveSoft(alice, cc).secretKey).toEqual(deriveSoft(alice, cc).secretKey);
    });

    it('refuses a chain code that is not 32 bytes', () => {
      expect(() => deriveSoft(deriveDev('Alice'), new Uint8Array(16))).toThrow(/32 bytes/);
    });
  });
});
