/**
 * A synthetic V16 runtime for the V5 builder's specs: a few types, System's
 * `remark`, and two pipelines laid out like Paseo Asset Hub Next's, encoded
 * with polkadot-api's own metadata codec.
 */
import { metadata as metadataCodec } from '@polkadot-api/substrate-bindings';
import type { SuppliedExtension } from './general.js';

type Metadata = Parameters<typeof metadataCodec.enc>[0];
type V16 = Extract<Metadata['metadata'], { tag: 'v16' }>['value'];
type Def = V16['lookup'][number]['def'];

const field = (type: number, name?: string) => ({ name, type, typeName: undefined, docs: [] });
const variant = (name: string, index: number, fields: ReturnType<typeof field>[] = []) => ({
  name,
  index,
  fields,
  docs: [],
});
const primitive = (tag: 'u8' | 'u32' | 'bool'): Def => ({
  tag: 'primitive',
  value: { tag, value: undefined },
});

/** Type ids of the synthetic runtime below. */
const T = {
  u8: 0,
  bytes32: 1,
  accountId: 2,
  bytes64: 3,
  multiSignature: 4,
  verifySignature: 5,
  unit: 6,
  u32: 7,
  compactU32: 8,
  bool: 9,
  bytes: 10,
  systemCalls: 11,
  optionU8: 12,
} as const;

const TYPES: Array<[number, Def, string[]?]> = [
  [T.u8, primitive('u8')],
  [T.bytes32, { tag: 'array', value: { len: 32, type: T.u8 } }],
  [T.accountId, { tag: 'composite', value: [field(T.bytes32)] }],
  [T.bytes64, { tag: 'array', value: { len: 64, type: T.u8 } }],
  [
    T.multiSignature,
    { tag: 'variant', value: [variant('Ed25519', 0, [field(T.bytes64)]), variant('Sr25519', 1, [field(T.bytes64)])] },
  ],
  // Paseo Asset Hub Next's order: `Disabled` first.
  [
    T.verifySignature,
    {
      tag: 'variant',
      value: [
        variant('Disabled', 0),
        variant('Signed', 1, [field(T.multiSignature, 'signature'), field(T.accountId, 'account')]),
      ],
    },
  ],
  [T.unit, { tag: 'tuple', value: [] }],
  [T.u32, primitive('u32')],
  [T.compactU32, { tag: 'compact', value: T.u32 }],
  [T.bool, primitive('bool')],
  [T.bytes, { tag: 'sequence', value: T.u8 }],
  [T.systemCalls, { tag: 'variant', value: [variant('remark', 0, [field(T.bytes, 'remark')])] }],
  [T.optionU8, { tag: 'variant', value: [variant('None', 0), variant('Some', 1, [field(T.u8)])] }, ['Option']],
];

/** Every extension either pipeline names: value type and implicit type. */
const EXTENSIONS = {
  UnitTransactionExtension: [T.unit, T.unit],
  // Non-empty and before the cut: in the body, not under the signature.
  CheckBeforeSignature: [T.bool, T.unit],
  VerifyMultiSignature: [T.verifySignature, T.unit],
  AsPgas: [T.optionU8, T.unit],
  CheckSpecVersion: [T.unit, T.u32],
  CheckNonce: [T.compactU32, T.unit],
} as const;
export type ExtensionId = keyof typeof EXTENSIONS;

export const PIPELINE_0: ExtensionId[] = ['CheckSpecVersion', 'CheckNonce'];
export const PIPELINE_1: ExtensionId[] = [
  'UnitTransactionExtension',
  'CheckBeforeSignature',
  'VerifyMultiSignature',
  'AsPgas',
  'CheckSpecVersion',
  'CheckNonce',
];

/** A V16 runtime with System (pallet 0, `remark` at call 0) and pipelines 0 and 1. */
export function syntheticMetadata(pipelines: Record<number, ExtensionId[]> = { 0: PIPELINE_0, 1: PIPELINE_1 }) {
  const ids = Object.keys(EXTENSIONS) as ExtensionId[];
  const value: V16 = {
    lookup: TYPES.map(([id, def, path = []]) => ({ id, path, params: [], def, docs: [] })),
    pallets: [
      {
        name: 'System',
        storage: undefined,
        calls: { type: T.systemCalls, deprecationInfo: [] },
        events: undefined,
        constants: [],
        errors: undefined,
        associatedTypes: [],
        viewFns: [],
        index: 0,
        docs: [],
        deprecationInfo: { tag: 'NotDeprecated', value: undefined },
      },
    ],
    extrinsic: {
      version: [4, 5],
      address: T.accountId,
      call: T.systemCalls,
      signature: T.multiSignature,
      signedExtensions: ids.map((identifier) => ({
        identifier,
        type: EXTENSIONS[identifier][0],
        additionalSigned: EXTENSIONS[identifier][1],
      })),
      signedExtensionsByVersion: Object.entries(pipelines).map(([version, names]) => [
        Number(version),
        names.map((name) => ids.indexOf(name)),
      ]),
    },
    apis: [],
    outerEnums: { call: T.systemCalls, event: T.unit, error: T.unit },
    custom: [],
  } as V16;
  return metadataCodec.enc({ magicNumber: 0x6174656d, metadata: { tag: 'v16', value } });
}

export const SPEC_VERSION = Uint8Array.of(0xa0, 0xd6, 0x2d, 0x00); // 3_004_000
export const NONCE = Uint8Array.of(0x1c); // Compact(7)
export const REMARK = Uint8Array.of(0x00, 0x00, 0x0c, 0x61, 0x62, 0x63); // System.remark(b"abc")

/** Pipeline 1's extensions as a product supplies them: without `VerifyMultiSignature`. */
export function suppliedExtensions(
  overrides: Partial<Record<ExtensionId, Partial<SuppliedExtension>>> = {},
): SuppliedExtension[] {
  const base: Record<string, [Uint8Array, Uint8Array]> = {
    UnitTransactionExtension: [new Uint8Array(), new Uint8Array()],
    CheckBeforeSignature: [Uint8Array.of(0x01), new Uint8Array()],
    AsPgas: [Uint8Array.of(0x00), new Uint8Array()],
    CheckSpecVersion: [new Uint8Array(), SPEC_VERSION],
    CheckNonce: [NONCE, new Uint8Array()],
  };
  return Object.entries(base).map(([id, [extra, additionalSigned]]) => ({
    id,
    extra,
    additionalSigned,
    ...overrides[id as ExtensionId],
  }));
}
