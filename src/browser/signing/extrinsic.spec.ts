import { verify } from '@scure/sr25519';
import { describe, expect, it } from 'vitest';
import { deriveDev } from '../dev-accounts.js';
import { buildSignedV4Extrinsic, signRawBytes } from './extrinsic.js';

describe('extrinsic signing', () => {
  const alice = deriveDev('Alice');
  const callData = new Uint8Array([0x00, 0x01, 0x02]);
  const extensions = [
    { extra: new Uint8Array([0xaa]), additionalSigned: new Uint8Array([0xbb]) },
  ];

  it('emits a signed v4 extrinsic with the expected header', () => {
    const extrinsic = buildSignedV4Extrinsic(alice, callData, extensions);
    // [compact len (2 bytes)][0x84 version+signed][0x00 MultiAddress::Id][32B account]
    // Compact encoding of 103 (inner length) = [0x9d, 0x01]
    expect(extrinsic[2]).toBe(0x84);
    expect(extrinsic[3]).toBe(0x00);
    expect(extrinsic.slice(4, 36)).toEqual(alice.publicKey);
  });

  it('marks the signature as MultiSignature::Sr25519', () => {
    const extrinsic = buildSignedV4Extrinsic(alice, callData, extensions);
    // With 2-byte compact length, 0x01 is at position 36
    expect(extrinsic[36]).toBe(0x01);
  });

  it('declares a length matching the bytes that follow', () => {
    const extrinsic = buildSignedV4Extrinsic(alice, callData, extensions);
    // With test data, inner length is 103, which uses 2-byte SCALE compact: [0x9d, 0x01]
    // Decoded: (0x9d | (0x01 << 8)) >> 2 = 413 >> 2 = 103
    const compactBytes = extrinsic.subarray(0, 2);
    const decodedLength = ((compactBytes[0] | (compactBytes[1] << 8)) >> 2);
    expect(decodedLength).toBe(extrinsic.length - 2);
  });

  it('signs raw bytes verifiably', () => {
    const message = new Uint8Array([1, 2, 3]);
    const signature = signRawBytes(alice, { tag: 'Bytes', value: message });
    expect(verify(message, signature, alice.publicKey)).toBe(true);
  });

  it('signs a text payload as its UTF-8 bytes', () => {
    const signature = signRawBytes(alice, { tag: 'Payload', value: 'hello' });
    expect(
      verify(new TextEncoder().encode('hello'), signature, alice.publicKey),
    ).toBe(true);
  });
});
