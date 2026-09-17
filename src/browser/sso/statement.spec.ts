// src/browser/sso/statement.spec.ts
import { describe, expect, it } from 'vitest';
import { deriveDev } from '../dev-accounts.js';
import { decodeStatement, encodeStatement, matchesTopics, signStatement } from './statement.js';

const topic = (fill: number) => new Uint8Array(32).fill(fill);

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
