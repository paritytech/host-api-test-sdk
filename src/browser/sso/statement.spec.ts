// src/browser/sso/statement.spec.ts
import { describe, expect, it } from 'vitest';
import { compact } from 'scale-ts';
import { deriveDev } from '../dev-accounts.js';
import {
  decodeStatement,
  encodeStatement,
  matchesTopics,
  signStatement,
  stripCompactPrefix,
} from './statement.js';

const topic = (fill: number) => new Uint8Array(32).fill(fill);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe('statement codec', () => {
  const base = {
    topics: [topic(7)],
    data: new Uint8Array([1, 2, 3, 4]),
    expiry: 1000n,
  };

  it('round-trips an unsigned statement', () => {
    expect(decodeStatement(encodeStatement(base))).toMatchObject(base);
  });

  it('attaches an sr25519 proof carrying the signer public key', () => {
    const alice = deriveDev('Alice');
    const signed = signStatement(alice.secretKey, base);
    expect(signed.proof?.signer).toEqual(alice.publicKey);
    expect(signed.proof?.signature).toHaveLength(64);
  });

  it('round-trips a signed statement', () => {
    const signed = signStatement(deriveDev('Alice').secretKey, base);
    expect(decodeStatement(encodeStatement(signed)).proof?.signature).toEqual(
      signed.proof?.signature,
    );
  });

  it('matches MatchAll only when every topic is present', () => {
    const statement = { ...base, topics: [topic(1), topic(2)] };
    expect(matchesTopics(statement, 'MatchAll', [topic(1), topic(2)])).toBe(true);
    expect(matchesTopics(statement, 'MatchAll', [topic(1), topic(3)])).toBe(false);
  });

  it('matches MatchAny when one topic is present', () => {
    const statement = { ...base, topics: [topic(1)] };
    expect(matchesTopics(statement, 'MatchAny', [topic(1), topic(3)])).toBe(true);
    expect(matchesTopics(statement, 'MatchAny', [topic(3)])).toBe(false);
  });
});

describe('stripCompactPrefix', () => {
  const payload = new Uint8Array([9, 9, 9]);

  it.each([
    ['single-byte mode', 3n],
    ['two-byte mode', 1000n],
    ['four-byte mode', 100_000n],
    ['big-integer mode', 2n ** 32n],
  ])('strips the prefix in %s', (_label, value) => {
    const prefix = compact.enc(value);
    expect(stripCompactPrefix(concatBytes(prefix, payload))).toEqual(payload);
  });
});
