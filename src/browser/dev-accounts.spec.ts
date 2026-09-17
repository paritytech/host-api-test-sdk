import { describe, expect, it } from 'vitest';
import { deriveDev, deriveFromUri } from './dev-accounts.js';

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
});
