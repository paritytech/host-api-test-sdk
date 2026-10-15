import { blake2b } from '@noble/hashes/blake2.js';
import { scale } from '@parity/truapi';
import { verify } from '@scure/sr25519';
import { describe, expect, it } from 'vitest';
import { deriveDev } from '../dev-accounts.js';
import {
  NONCE,
  PIPELINE_0,
  PIPELINE_1,
  REMARK,
  SPEC_VERSION,
  suppliedExtensions,
  syntheticMetadata,
} from './general.fixture.js';
import { buildSignedV5Extrinsic, metadataFromRuntimeCall, readTransactionMetadata } from './general.js';

const alice = deriveDev('Alice');
const remark = REMARK;
const supplied = suppliedExtensions;

/** Check and strip the compact length; the tests below assert on the inner bytes. */
function inner(extrinsic: Uint8Array): Uint8Array {
  const length = Number(scale.compact.dec(extrinsic));
  const prefix = scale.compact.enc(length).length;
  expect(extrinsic.length).toBe(prefix + length);
  return extrinsic.subarray(prefix);
}

describe('V5 general transactions', () => {
  const metadata = readTransactionMetadata(syntheticMetadata());

  it('reads the pipelines in the runtime order', () => {
    expect([...metadata.pipelines.keys()]).toEqual([0, 1]);
    expect(metadata.pipelines.get(1)!.map((extension) => extension.id)).toEqual(PIPELINE_1);
    expect(metadata.pallets.get(0)).toEqual({ name: 'System', calls: new Set([0]) });
  });

  it('lays out [0x45][version][values in pipeline order][call]', () => {
    const tx = inner(buildSignedV5Extrinsic(alice, metadata, 1, remark, supplied()));
    expect([...tx.subarray(0, 2)]).toEqual([0x45, 1]);
    // CheckBeforeSignature, then Signed (index 1) + Sr25519 (index 1) + 64 + 32 bytes.
    expect(tx[2]).toBe(0x01);
    expect([...tx.subarray(3, 5)]).toEqual([0x01, 0x01]);
    expect([...tx.subarray(69, 101)]).toEqual([...alice.publicKey]);
    // AsPgas None, CheckNonce; the empty UnitTransactionExtension and CheckSpecVersion are absent.
    expect([...tx.subarray(101, 103)]).toEqual([0x00, 0x1c]);
    expect([...tx.subarray(103)]).toEqual([...remark]);
  });

  it('signs blake2_256(version, call, then values and implicits after VerifyMultiSignature)', () => {
    const tx = inner(buildSignedV5Extrinsic(alice, metadata, 1, remark, supplied()));
    const signature = tx.subarray(5, 69);
    // CheckBeforeSignature precedes the cut and is left out.
    const payload = Uint8Array.from([1, ...remark, 0x00, ...NONCE, ...SPEC_VERSION]);
    expect(verify(blake2b(payload, { dkLen: 32 }), signature, alice.publicKey)).toBe(true);
  });

  it('takes the Signed variant index from the metadata', () => {
    const tx = inner(buildSignedV5Extrinsic(alice, metadata, 1, remark, supplied()));
    expect(tx[3]).toBe(1);
  });

  it('leaves a supplied VerifyMultiSignature unsigned and in place', () => {
    const disabled = { id: 'VerifyMultiSignature', extra: Uint8Array.of(0x00), additionalSigned: new Uint8Array() };
    const tx = inner(buildSignedV5Extrinsic(alice, metadata, 1, remark, [...supplied(), disabled]));
    expect([...tx]).toEqual([0x45, 1, 0x01, 0x00, 0x00, 0x1c, ...remark]);
  });

  it('accepts an empty-typed extension left out', () => {
    const withoutUnit = supplied().filter((extension) => extension.id !== 'UnitTransactionExtension');
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, remark, withoutUnit)).not.toThrow();
  });

  it('refuses a version the runtime does not declare', () => {
    expect(() => buildSignedV5Extrinsic(alice, metadata, 2, remark, supplied())).toThrow(
      'unsupported tx_ext_version 2; the runtime declares transaction extension versions [0, 1]',
    );
  });

  it('refuses a pipeline without VerifyMultiSignature', () => {
    expect(() => buildSignedV5Extrinsic(alice, metadata, 0, remark, supplied())).toThrow(
      'pipeline version 0 does not declare VerifyMultiSignature, so the host cannot authorize this transaction',
    );
  });

  it('refuses an extension no pipeline declares', () => {
    const extra = { id: 'CheckMadeUp', extra: new Uint8Array(), additionalSigned: new Uint8Array() };
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, remark, [...supplied(), extra])).toThrow(
      /transaction extension "CheckMadeUp" is not declared by the runtime at any pipeline version/,
    );
  });

  it('refuses an extension listed twice', () => {
    const [first] = supplied();
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, remark, [...supplied(), first!])).toThrow(
      /listed more than once/,
    );
  });

  it('refuses a non-empty extension left out, in the step that reads it', () => {
    const missing = (id: string) => supplied().filter((extension) => extension.id !== id);
    const reason = (id: string) =>
      `Extrinsic encoding failed: cannot encode transaction extensions: Cannot encode transaction extension '${id}': the caller supplied no bytes for this transaction extension`;
    // After the cut it is under the signature; before it, only in the body.
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, remark, missing('CheckNonce'))).toThrow(
      `V5 signer payload: ${reason('CheckNonce')}`,
    );
    expect(() =>
      buildSignedV5Extrinsic(alice, metadata, 1, remark, missing('CheckBeforeSignature')),
    ).toThrow(`V5 transaction: ${reason('CheckBeforeSignature')}`);
  });

  it('refuses a call the runtime does not declare, in frame-decode words', () => {
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, Uint8Array.of(0, 9), supplied())).toThrow(
      "V5 call metadata: Call with index 9 not found in pallet 'System' (pallet index 0).",
    );
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, Uint8Array.of(7, 0), supplied())).toThrow(
      'V5 call metadata: Pallet with index 7 not found',
    );
  });

  it('refuses call data too short to name a call', () => {
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, new Uint8Array(), supplied())).toThrow(
      'V5 call data is missing its pallet index',
    );
    expect(() => buildSignedV5Extrinsic(alice, metadata, 1, Uint8Array.of(0), supplied())).toThrow(
      'V5 call data is missing its call index',
    );
  });

  it('signs only what follows the last VerifyMultiSignature', () => {
    const twice = readTransactionMetadata(
      syntheticMetadata({
        0: PIPELINE_0,
        1: ['VerifyMultiSignature', 'AsPgas', 'VerifyMultiSignature', 'CheckNonce'],
      }),
    );
    const extensions = supplied().filter((e) => e.id === 'AsPgas' || e.id === 'CheckNonce');
    const tx = inner(buildSignedV5Extrinsic(alice, twice, 1, remark, extensions));
    // [0x45][1][Signed][Sr25519][sig][account][AsPgas][Signed][Sr25519][sig][account][CheckNonce][call]
    const signature = tx.subarray(4, 68);
    expect(verify(blake2b(Uint8Array.from([1, ...remark, ...NONCE]), { dkLen: 32 }), signature, alice.publicKey)).toBe(true);
  });

  it('refuses metadata that does not decode with a reason', () => {
    expect(() => readTransactionMetadata(Uint8Array.of(1, 2, 3))).toThrow(
      'the runtime metadata does not decode (3 bytes)',
    );
  });
});

describe('metadataFromRuntimeCall', () => {
  it('reads None as no metadata at that version', () => {
    expect(metadataFromRuntimeCall(Uint8Array.of(0x00))).toBeUndefined();
  });

  it('unwraps Some(OpaqueMetadata)', () => {
    const bytes = syntheticMetadata();
    const answer = Uint8Array.from([0x01, ...scale.compact.enc(bytes.length), ...bytes]);
    expect(metadataFromRuntimeCall(answer)).toEqual(bytes);
  });
});
