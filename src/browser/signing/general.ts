/**
 * Extrinsic V5 general transactions, which a signing host builds for a
 * non-zero `txExtVersion`.
 *
 * Mirrors `build_signed_extrinsic_v5` in the core
 * (`rust/crates/truapi/src/host_internal/extrinsic.rs`). The core leaves the
 * layout to frame-decode 0.18 (`encode_v5_general_with_info_to`,
 * `encode_v5_signer_payload_with_info`) and `VerifyMultiSignature`'s value to
 * subxt's `VerifySignature`, which encodes by name against the metadata. Both
 * are reproduced here. The runtime metadata supplies the pipeline: which
 * versions exist, the order of their extensions, which of them encode to
 * nothing, and where `VerifyMultiSignature` sits.
 *
 * Loaded on demand: only a transaction on a non-zero version needs it, and the
 * metadata decoder it brings stays out of the host's startup bundle.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { scale } from '@parity/truapi';
import { sign } from '@scure/sr25519';
import type { DevKeypair } from '../dev-accounts.js';

/** The runtime name of the V5 authorization extension. */
export const VERIFY_MULTI_SIGNATURE = 'VerifyMultiSignature';

/** `0b01 << 6 | 5`: the general-transaction bits plus extrinsic format version 5. */
const EXTRINSIC_V5_GENERAL = 0x45;

type Lookup = ReturnType<typeof unifyMetadata>['lookup'];
type TypeDef = Lookup[number]['def'];

/** One extension of a pipeline: its value type and its implicit type. */
export interface PipelineExtension {
  id: string;
  type: number;
  implicitType: number;
}

/** What building a transaction needs from the runtime metadata. */
export interface TransactionMetadata {
  /** Each declared transaction-extension version, in the runtime's order. */
  pipelines: ReadonlyMap<number, readonly PipelineExtension[]>;
  types: ReadonlyMap<number, TypeDef>;
  /** Each pallet by index: its name and the call indices it declares. */
  pallets: ReadonlyMap<number, { name: string; calls: ReadonlySet<number> }>;
}

/** The caller's pre-encoded extension bytes, as the request carries them. */
export interface SuppliedExtension {
  id: string;
  extra: Uint8Array;
  additionalSigned: Uint8Array;
}

/** Read a SCALE-encoded `RuntimeMetadataPrefixed` (V14 to V16). */
export function readTransactionMetadata(metadata: Uint8Array): TransactionMetadata {
  let unified: ReturnType<typeof unifyMetadata>;
  try {
    unified = unifyMetadata(decAnyMetadata(metadata));
  } catch (cause) {
    // `decAnyMetadata` throws `null` on bytes it cannot read, which says nothing.
    const why = cause instanceof Error ? `: ${cause.message}` : '';
    throw new Error(`the runtime metadata does not decode (${metadata.length} bytes)${why}`, {
      cause,
    });
  }
  const types = new Map(unified.lookup.map((entry) => [entry.id, entry.def]));

  const pipelines = new Map<number, PipelineExtension[]>();
  for (const [version, extensions] of Object.entries(unified.extrinsic.extensionsByVersion)) {
    pipelines.set(
      Number(version),
      extensions.map((extension) => ({
        id: extension.identifier,
        type: extension.type,
        implicitType: extension.additionalSigned,
      })),
    );
  }

  const pallets = new Map<number, { name: string; calls: Set<number> }>();
  for (const pallet of unified.pallets) {
    const def = pallet.calls ? types.get(pallet.calls.type) : undefined;
    const calls = def?.tag === 'variant' ? def.value.map((variant) => variant.index) : [];
    pallets.set(pallet.index, { name: pallet.name, calls: new Set(calls) });
  }

  return { pipelines, types, pallets };
}

/**
 * Whether a type encodes to zero bytes. frame-decode leaves such extensions out
 * of both the transaction and the signer payload (`is_type_empty`), so their
 * supplied bytes are never read.
 */
function isEmptyType(types: TransactionMetadata['types'], id: number, depth = 0): boolean {
  const def = types.get(id);
  // A type graph this deep is not an extension's; calling it non-empty is the
  // safe answer, and it is the one frame-decode gives a kind it does not handle.
  if (!def || depth > 32) return false;
  switch (def.tag) {
    case 'composite':
      return def.value.every((field) => isEmptyType(types, field.type, depth + 1));
    case 'tuple':
      return def.value.every((field) => isEmptyType(types, field, depth + 1));
    case 'array':
      return def.value.len === 0 || isEmptyType(types, def.value.type, depth + 1);
    default:
      return false;
  }
}

/** The length of `[u8; N]`, looking through single-field wrappers like `AccountId32`. */
function byteArrayLength(types: TransactionMetadata['types'], id: number): number | undefined {
  const def = types.get(id);
  if (def?.tag === 'composite' && def.value.length === 1) {
    return byteArrayLength(types, def.value[0]!.type);
  }
  if (def?.tag !== 'array') return undefined;
  const inner = types.get(def.value.type);
  return inner?.tag === 'primitive' && inner.value.tag === 'u8' ? def.value.len : undefined;
}

/**
 * `VerifyMultiSignature::Signed { signature, account }` for an sr25519 key.
 * Variant indices come from the metadata by name: Paseo Asset Hub Next declares
 * `Disabled` as 0 and `Signed` as 1, the reverse of subxt's Rust enum.
 */
function encodeSignedVerifySignature(
  types: TransactionMetadata['types'],
  typeId: number,
  signature: Uint8Array,
  account: Uint8Array,
): Uint8Array {
  const fail = (why: string) =>
    new Error(`V5 signature extension: ${VERIFY_MULTI_SIGNATURE} ${why}`);
  const def = types.get(typeId);
  const signed = def?.tag === 'variant' ? def.value.find((v) => v.name === 'Signed') : undefined;
  if (!signed) throw fail('has no `Signed` variant');

  const parts: Uint8Array[] = [new Uint8Array([signed.index])];
  for (const field of signed.fields) {
    if (field.name === 'signature') {
      const multiSignature = types.get(field.type);
      const sr25519 =
        multiSignature?.tag === 'variant'
          ? multiSignature.value.find((v) => v.name === 'Sr25519')
          : undefined;
      if (!sr25519 || sr25519.fields.length !== 1) throw fail('takes no sr25519 signature');
      if (byteArrayLength(types, sr25519.fields[0]!.type) !== signature.length) {
        throw fail('takes an sr25519 signature of another length');
      }
      parts.push(new Uint8Array([sr25519.index]), signature);
    } else if (field.name === 'account') {
      if (byteArrayLength(types, field.type) !== account.length) {
        throw fail('takes an account of another length');
      }
      parts.push(account);
    } else {
      throw fail(`has an unknown field ${String(field.name)}`);
    }
  }
  return concatBytes(...parts);
}

/**
 * Assemble and sign an Extrinsic V5 general transaction on pipeline `version`:
 *
 *   [compact len][0x45][version][Σ value, pipeline order][callData]
 *
 * The signature covers `blake2_256(version || callData || Σ value || Σ implicit)`
 * over the extensions after the last `VerifyMultiSignature`, always hashed,
 * with zero-sized types left out of both sums. `VerifyMultiSignature` is the
 * host's only while `extensions` omits it: a caller that supplies it owns its
 * bytes and gets no signature, as in the core.
 *
 * Errors carry the core's wording, frame-decode's and subxt-metadata's
 * included. The supplied bytes are not checked against their types, which the
 * core does (`traverse_exactly`), so a malformed one is refused by the chain as
 * `BadProof` rather than here.
 */
export function buildSignedV5Extrinsic(
  keypair: DevKeypair,
  metadata: TransactionMetadata,
  version: number,
  callData: Uint8Array,
  extensions: readonly SuppliedExtension[],
): Uint8Array {
  const pipeline = metadata.pipelines.get(version);
  if (!pipeline) {
    // `LocalTransactionError::UnsupportedTxExtVersion`.
    const declared = [...metadata.pipelines.keys()].join(', ');
    throw new Error(
      `unsupported tx_ext_version ${version}; the runtime declares transaction extension versions [${declared}]`,
    );
  }

  const [palletIndex, callIndex] = callData;
  if (palletIndex === undefined) throw new Error('V5 call data is missing its pallet index');
  if (callIndex === undefined) throw new Error('V5 call data is missing its call index');
  // frame-decode's `ExtrinsicInfoError`, as subxt-metadata raises it.
  const pallet = metadata.pallets.get(palletIndex);
  if (!pallet) throw new Error(`V5 call metadata: Pallet with index ${palletIndex} not found`);
  if (!pallet.calls.has(callIndex)) {
    throw new Error(
      `V5 call metadata: Call with index ${callIndex} not found in pallet '${pallet.name}' (pallet index ${palletIndex}).`,
    );
  }

  const declaredAnywhere = new Set(
    [...metadata.pipelines.values()].flatMap((extensions) => extensions.map((e) => e.id)),
  );
  const supplied = new Map<string, SuppliedExtension>();
  for (const extension of extensions) {
    if (supplied.has(extension.id)) {
      throw new Error(
        `transaction extension "${extension.id}" is listed more than once; every reader takes the first entry, so the rest would be dropped in silence`,
      );
    }
    if (!declaredAnywhere.has(extension.id)) {
      throw new Error(
        `transaction extension "${extension.id}" is not declared by the runtime at any pipeline version; encoding uses version ${version}, and the declared names across all versions are [${[...declaredAnywhere].sort().join(', ')}]`,
      );
    }
    supplied.set(extension.id, extension);
  }

  // The last one, as frame-decode cuts at the last authorization extension.
  const cut = pipeline.map((extension) => extension.id).lastIndexOf(VERIFY_MULTI_SIGNATURE);
  if (cut < 0) {
    const whose = supplied.has(VERIFY_MULTI_SIGNATURE)
      ? 'the supplied value cannot authorize'
      : 'the host cannot authorize';
    throw new Error(
      `pipeline version ${version} does not declare ${VERIFY_MULTI_SIGNATURE}, so ${whose} this transaction`,
    );
  }
  const hostSigns = !supplied.has(VERIFY_MULTI_SIGNATURE);

  /** The supplied bytes; a missing entry fails in the encoding step that reads it. */
  const bytesOf =
    (part: 'extra' | 'additionalSigned', step: 'V5 signer payload' | 'V5 transaction') =>
    (extension: PipelineExtension): Uint8Array => {
      const bytes = supplied.get(extension.id)?.[part];
      if (!bytes) {
        throw new Error(
          `${step}: Extrinsic encoding failed: cannot encode transaction extensions: Cannot encode transaction extension '${extension.id}': the caller supplied no bytes for this transaction extension`,
        );
      }
      return bytes;
    };
  const withValue = (extension: PipelineExtension) => !isEmptyType(metadata.types, extension.type);
  const withImplicit = (extension: PipelineExtension) =>
    !isEmptyType(metadata.types, extension.implicitType);

  let authorization: Uint8Array | undefined;
  if (hostSigns) {
    const signed = pipeline.slice(cut + 1);
    const payload = concatBytes(
      new Uint8Array([version]),
      callData,
      ...signed.filter(withValue).map(bytesOf('extra', 'V5 signer payload')),
      ...signed.filter(withImplicit).map(bytesOf('additionalSigned', 'V5 signer payload')),
    );
    const signature = sign(keypair.secretKey, blake2b(payload, { dkLen: 32 }));
    authorization = encodeSignedVerifySignature(
      metadata.types,
      pipeline[cut]!.type,
      signature,
      keypair.publicKey,
    );
  }

  const valueOf = bytesOf('extra', 'V5 transaction');
  const inner = concatBytes(
    new Uint8Array([EXTRINSIC_V5_GENERAL, version]),
    ...pipeline
      .filter(withValue)
      .map((extension) =>
        authorization && extension.id === VERIFY_MULTI_SIGNATURE ? authorization : valueOf(extension),
      ),
    callData,
  );
  return concatBytes(scale.compact.enc(inner.length), inner);
}

const OptionalMetadata = scale.Option(scale.Bytes());

/**
 * The metadata out of a `Metadata_metadata_at_version` answer, an
 * `Option<OpaqueMetadata>`; `undefined` when the runtime has no such version.
 */
export function metadataFromRuntimeCall(answer: Uint8Array): Uint8Array | undefined {
  // Copies both ways: scale-ts decodes a view from its buffer's start, and
  // hands back a view into its input.
  return OptionalMetadata.dec(answer.slice())?.slice();
}
