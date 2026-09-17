import { describe, expect, it } from 'vitest';
import { canonicalSecretKey, deriveDev, deriveFromUri } from './dev-accounts.js';

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
});
