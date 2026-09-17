import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { open, seal, sessionAeadKey } from './crypto.js';

describe('sso channel crypto', () => {
  const hostSecret = x25519.utils.randomSecretKey();
  const peerSecret = x25519.utils.randomSecretKey();
  const hostPublic = x25519.getPublicKey(hostSecret);
  const peerPublic = x25519.getPublicKey(peerSecret);

  it('derives the same key from either side of the channel', () => {
    expect(sessionAeadKey(hostSecret, peerPublic)).toEqual(
      sessionAeadKey(peerSecret, hostPublic),
    );
  });

  it('round-trips a payload', () => {
    const key = sessionAeadKey(hostSecret, peerPublic);
    const message = new TextEncoder().encode('sign this');
    expect(open(key, seal(key, message))).toEqual(message);
  });

  it('rejects an all-zero peer key as non-contributory', () => {
    expect(() => sessionAeadKey(hostSecret, new Uint8Array(32))).toThrow(
      /invalid X25519 public key/,
    );
  });

  it('fails to open under the wrong key', () => {
    const sealed = seal(sessionAeadKey(hostSecret, peerPublic), new Uint8Array([1, 2, 3]));
    const wrong = sessionAeadKey(x25519.utils.randomSecretKey(), peerPublic);
    expect(() => open(wrong, sealed)).toThrow();
  });
});
